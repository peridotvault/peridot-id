import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { LedgerService } from "./ledger.service";
import { buildThresholds, DEFAULT_FORMULA } from "./xp-curve";

const POLICY_ID = "policy-v1";
const ACTIVE = {
  policy: { id: POLICY_ID },
  formula: DEFAULT_FORMULA,
  thresholds: buildThresholds(100, DEFAULT_FORMULA),
};
const levelsMock = { getActivePolicy: jest.fn(async () => ACTIVE) } as never;

/** P2002 carrier (mirrors the driver's unique-violation shape). */
function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));

interface FakeTables {
  states: Map<string, { pid: string; totalXp: bigint; level: number; policyVersionId: string }>;
  entries: Array<{ id: string; pid: string; deltaXp: bigint; balanceAfter: bigint; levelAfter: number; kind: string; eventId: string | null }>;
  completions: Map<string, { pid: string; taskId: string; eventId: string }>;
  tasks: Map<string, { id: string; recurring: string }>;
}

/**
 * In-memory Prisma stand-in that emulates the production concurrency
 * contract: `SELECT ... FOR UPDATE` on user_xp_states serializes same-pid
 * transactions (per-pid mutex held to txn end); unique(eventId) raises
 * P2002 on concurrent double-insert. Whole-txn serialization is NOT
 * assumed — interleaving happens at every await, like the real driver.
 */
function fakePrisma(tables: FakeTables) {
  const locks = new Map<string, Promise<void>>();
  const acquire = async (pid: string): Promise<() => void> => {
    const prev = locks.get(pid) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((r) => (release = r));
    locks.set(pid, prev.then(() => cur));
    await prev;
    return () => {
      release();
      if (locks.get(pid)?.then) {
        // Drop the chain link only if nothing newer queued behind it.
        locks.delete(pid);
      }
    };
  };

  const txFace = (releases: Array<() => void>) => ({
    $queryRaw: async (sql: { values?: unknown[] }) => {
      await tick();
      const pid = String(sql.values?.[0] ?? "");
      releases.push(await acquire(pid));
      await tick();
      return tables.states.has(pid) ? [{ pid }] : [];
    },
    userXpState: {
      findUnique: async ({ where }: { where: { pid: string } }) => {
        await tick();
        return tables.states.get(where.pid) ?? null;
      },
      findUniqueOrThrow: async ({ where }: { where: { pid: string } }) => {
        await tick();
        const row = tables.states.get(where.pid);
        if (!row) throw new Error("not found");
        return row;
      },
      create: async ({ data }: { data: { pid: string; totalXp: bigint; level: number; policyVersionId: string } }) => {
        await tick();
        if (tables.states.has(data.pid)) throw p2002(["pid"]);
        const row = { ...data };
        tables.states.set(data.pid, row);
        return row;
      },
      update: async ({ where, data }: { where: { pid: string }; data: Partial<{ totalXp: bigint; level: number; policyVersionId: string }> }) => {
        await tick();
        const row = tables.states.get(where.pid);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ where }: { where?: { pid?: { in: string[] } } }) => {
        await tick();
        const rows = [...tables.states.values()];
        return where?.pid?.in ? rows.filter((r) => where.pid!.in.includes(r.pid)) : rows;
      },
    },
    xpTaskCompletion: {
      findUnique: async ({ where }: { where: { eventId: string } }) => {
        await tick();
        return tables.completions.get(where.eventId) ?? null;
      },
      create: async ({ data }: { data: { pid: string; taskId: string; eventId: string } }) => {
        await tick();
        if (tables.completions.has(data.eventId)) throw p2002(["eventId"]);
        const row = { pid: data.pid, taskId: data.taskId, eventId: data.eventId };
        tables.completions.set(data.eventId, row);
        return row;
      },
    },
    xpTask: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        await tick();
        return tables.tasks.get(where.id) ?? null;
      },
    },
    xpLedgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        await tick();
        const row = {
          id: `e${tables.entries.length + 1}`,
          pid: data.pid,
          deltaXp: data.deltaXp,
          balanceAfter: data.balanceAfter,
          levelAfter: data.levelAfter,
          kind: data.kind,
          eventId: (data.eventId as string | null) ?? null,
        } as FakeTables["entries"][number];
        tables.entries.push(row);
        return row;
      },
      groupBy: async ({ by: _by, where }: { by: string[]; where?: { pid?: string } }) => {
        await tick();
        const sums = new Map<string, bigint>();
        for (const e of tables.entries) {
          if (where?.pid && e.pid !== where.pid) continue;
          sums.set(e.pid, (sums.get(e.pid) ?? 0n) + e.deltaXp);
        }
        return [...sums.entries()].map(([pid, total]) => ({ pid, _sum: { deltaXp: total } }));
      },
    },
  });

  return {
    $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      const releases: Array<() => void> = [];
      try {
        return await cb(txFace(releases));
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
    userXpState: {
      findUnique: async ({ where }: { where: { pid: string } }) => tables.states.get(where.pid) ?? null,
      findMany: async ({ where }: { where?: { pid?: { in: string[] } } }) => {
        const rows = [...tables.states.values()];
        return where?.pid?.in ? rows.filter((r) => where.pid!.in.includes(r.pid)) : rows;
      },
    },
    xpLedgerEntry: {
      groupBy: async ({ where }: { where?: { pid?: string } }) => {
        const sums = new Map<string, bigint>();
        for (const e of tables.entries) {
          if (where?.pid && e.pid !== where.pid) continue;
          sums.set(e.pid, (sums.get(e.pid) ?? 0n) + e.deltaXp);
        }
        return [...sums.entries()].map(([pid, total]) => ({ pid, _sum: { deltaXp: total } }));
      },
    },
  } as never;
}

function setup() {
  const tables: FakeTables = { states: new Map(), entries: [], completions: new Map(), tasks: new Map() };
  tables.tasks.set("task-onboarding", { id: "task-onboarding", recurring: "once" });
  const prisma = fakePrisma(tables);
  const service = new LedgerService(prisma as never, levelsMock);
  return { service, tables };
}

describe("LedgerService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("awards XP: appends one entry, upserts state, computes level", async () => {
    const { service, tables } = setup();
    const r = await service.awardXp({ pid: "ifal@pid", deltaXp: 50, kind: "manual_adjustment", reason: "test" });

    expect(r).toMatchObject({ pid: "ifal@pid", awardedXp: 50, level: 1, leveledUp: false, duplicate: false });
    expect(r.totalXp).toBe(50n);
    expect(tables.entries).toHaveLength(1);
    expect(tables.entries[0]).toMatchObject({ pid: "ifal@pid", deltaXp: 50n, balanceAfter: 50n, levelAfter: 1 });
    expect(tables.states.get("ifal@pid")).toMatchObject({ totalXp: 50n, level: 1, policyVersionId: POLICY_ID });
  });

  it("levels up across the L1→L2 band edge (100 XP)", async () => {
    const { service } = setup();
    await service.awardXp({ pid: "ifal@pid", deltaXp: 50, kind: "manual_adjustment" });
    const r = await service.awardXp({ pid: "ifal@pid", deltaXp: 60, kind: "manual_adjustment" });
    expect(r.totalXp).toBe(110n);
    expect(r.level).toBe(2);
    expect(r.leveledUp).toBe(true);
  });

  it("validates at the boundary", async () => {
    const { service } = setup();
    await expect(service.awardXp({ pid: "ifal@pid", deltaXp: 0, kind: "manual_adjustment" })).rejects.toThrow(BadRequestException);
    await expect(service.awardXp({ pid: "ifal@pid", deltaXp: -5, kind: "manual_adjustment" })).rejects.toThrow(BadRequestException);
    await expect(service.awardXp({ pid: "nope", deltaXp: 5, kind: "manual_adjustment" })).rejects.toThrow(BadRequestException);
    await expect(service.awardXp({ pid: "ifal@pid", deltaXp: 5, kind: "bogus" as never })).rejects.toThrow(BadRequestException);
    await expect(service.awardXp({ pid: "ifal@pid", deltaXp: 5, kind: "task_award", eventId: "e1" })).rejects.toThrow(/requires taskId/);
    await expect(
      service.awardXp({ pid: "ifal@pid", deltaXp: 5, kind: "task_award", taskId: "missing", eventId: "e1" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("duplicate eventId awards once (idempotent retry)", async () => {
    const { service, tables } = setup();
    const first = await service.awardXp({
      pid: "ifal@pid",
      deltaXp: 50,
      kind: "task_award",
      taskId: "task-onboarding",
      eventId: "evt-1",
    });
    expect(first.duplicate).toBe(false);
    const second = await service.awardXp({
      pid: "ifal@pid",
      deltaXp: 50,
      kind: "task_award",
      taskId: "task-onboarding",
      eventId: "evt-1",
    });
    expect(second).toMatchObject({ duplicate: true, awardedXp: 0, level: 1 });
    expect(second.totalXp).toBe(50n);
    expect(tables.entries).toHaveLength(1);
  });

  it("concurrency: 20 parallel distinct awards sum exactly (no lost update)", async () => {
    const { service, tables } = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.awardXp({ pid: "racer@pid", deltaXp: 10, kind: "manual_adjustment", reason: `w${i}` }),
      ),
    );
    expect(results.every((r) => !r.duplicate)).toBe(true);
    expect(tables.entries).toHaveLength(20);
    const state = tables.states.get("racer@pid")!;
    expect(state.totalXp).toBe(200n);
    expect(state.level).toBe(2); // 200 XP clears the L2 band edge (100)
    // balanceAfter chain is gapless: 10, 20, …, 200.
    const balances = tables.entries.map((e) => e.balanceAfter).sort((a, b) => Number(a - b));
    expect(balances).toEqual(Array.from({ length: 20 }, (_, i) => BigInt((i + 1) * 10)));
    await expect(service.reconcile("racer@pid")).resolves.toEqual({ ok: true, mismatches: [] });
  });

  it("concurrency: 10 parallel identical events award exactly once", async () => {
    const { service, tables } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.awardXp({
          pid: "racer@pid",
          deltaXp: 50,
          kind: "task_award",
          taskId: "task-onboarding",
          eventId: "evt-race",
        }),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(9);
    expect(tables.entries).toHaveLength(1);
    expect(tables.states.get("racer@pid")?.totalXp).toBe(50n);
  });

  it("reconcile: sum(ledger) == state; drift is reported, empty is clean", async () => {
    const { service, tables } = setup();
    await expect(service.reconcile("nobody@pid")).resolves.toEqual({ ok: true, mismatches: [] });
    await service.awardXp({ pid: "ifal@pid", deltaXp: 50, kind: "manual_adjustment" });
    await expect(service.reconcile("ifal@pid")).resolves.toEqual({ ok: true, mismatches: [] });
    // Simulate out-of-band drift (admin SQL, crash between writes).
    tables.states.get("ifal@pid")!.totalXp = 999n;
    await expect(service.reconcile("ifal@pid")).resolves.toEqual({
      ok: false,
      mismatches: [{ pid: "ifal@pid", ledgerTotal: 50n, stateTotal: 999n }],
    });
  });
});
