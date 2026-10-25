import { ServiceUnavailableException } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { PolicyBackfillService } from "./policy-backfill.service";
import { buildThresholds, DEFAULT_FORMULA } from "./xp-curve";

/**
 * ANT-89 M3 (ANT-441) — R4 policy-migration tooling regression suite.
 *
 * Proves: paged checkpointed backfill converges + resumes; re-runs are
 * idempotent; rollback drafts a NEW version (history stays append-only);
 * recovery verification catches drift; the LEDGER IS NEVER TOUCHED
 * (immutability invariant — the fake has no ledger write delegate, so any
 * ledger write would throw); execution is release-gated.
 */
const POLICY_A = "policy-a";
const POLICY_B = "policy-b";
const THRESHOLDS_A = buildThresholds(100, DEFAULT_FORMULA);
const THRESHOLDS_B = buildThresholds(100, { base: 200, exponent: 1.5, rounding: "floor" });

interface FakeTables {
  policies: Map<string, { id: string; version: number; formula: unknown; maxLevel: number | null }>;
  thresholds: Map<string, Array<{ level: number; cumulativeXp: number }>>;
  states: Map<string, { pid: string; totalXp: bigint; level: number; policyVersionId: string }>;
  audit: Array<{ event: string; meta: unknown }>;
}

function setup(opts: { states?: Array<{ pid: string; totalXp: bigint; level: number; policyVersionId: string }>; activeId?: string; gate?: boolean } = {}) {
  const tables: FakeTables = {
    policies: new Map([
      [POLICY_A, { id: POLICY_A, version: 1, formula: { ...DEFAULT_FORMULA }, maxLevel: 100 }],
      [POLICY_B, { id: POLICY_B, version: 2, formula: { base: 200, exponent: 1.5, rounding: "floor" as const }, maxLevel: 100 }],
    ]),
    thresholds: new Map([
      [POLICY_A, THRESHOLDS_A.map((t) => ({ level: t.level, cumulativeXp: t.cumulativeXp }))],
      [POLICY_B, THRESHOLDS_B.map((t) => ({ level: t.level, cumulativeXp: t.cumulativeXp }))],
    ]),
    states: new Map((opts.states ?? []).map((s) => [s.pid, { ...s }])),
    audit: [],
  };
  const activeId = opts.activeId ?? POLICY_A;
  const prisma = {
    xpPolicyVersion: {
      findUnique: async ({ where }: { where: { id: string } | { version: number } }) => {
        if ("id" in where) return tables.policies.get(where.id) ?? null;
        return [...tables.policies.values()].find((p) => p.version === (where as { version: number }).version) ?? null;
      },
      aggregate: async () => ({ _max: { version: Math.max(...[...tables.policies.values()].map((p) => p.version)) } }),
      create: async ({ data }: { data: { version: number; formula: unknown; maxLevel: number | null; createdBy: string } }) => {
        const row = { id: `policy-v${data.version}`, ...data };
        tables.policies.set(row.id, row);
        return row;
      },
      findFirst: async () => tables.policies.get(activeId) ?? null,
    },
    xpLevelThreshold: {
      count: async ({ where }: { where: { policyVersionId: string } }) => tables.thresholds.get(where.policyVersionId)?.length ?? 0,
      findMany: async ({ where }: { where: { policyVersionId: string } }) =>
        (tables.thresholds.get(where.policyVersionId) ?? []).map((t) => ({ ...t })),
      createMany: async ({ data }: { data: Array<{ policyVersionId: string; level: number; cumulativeXp: bigint | number }> }) => {
        const rows = data.map((d) => ({ level: d.level, cumulativeXp: Number(d.cumulativeXp) }));
        tables.thresholds.set(data[0].policyVersionId, rows);
        return { count: rows.length };
      },
      deleteMany: async () => ({ count: 0 }),
    },
    userXpState: {
      count: async ({ where }: { where?: { policyVersionId?: string | { not: string } } } = {}) => {
        const rows = [...tables.states.values()];
        if (!where?.policyVersionId) return rows.length;
        return typeof where.policyVersionId === "string"
          ? rows.filter((r) => r.policyVersionId === where.policyVersionId).length
          : rows.filter((r) => r.policyVersionId !== (where.policyVersionId as { not: string }).not).length;
      },
      findMany: async ({ where, orderBy, take }: { where?: { pid?: { gt: string } }; orderBy?: { pid: string }; take?: number }) => {
        void orderBy;
        const rows = [...tables.states.values()].sort((a, b) => (a.pid < b.pid ? -1 : 1));
        const filtered = where?.pid ? rows.filter((r) => r.pid > where.pid!.gt) : rows;
        return filtered.slice(0, take ?? filtered.length).map((r) => ({ ...r }));
      },
      update: async ({ where, data }: { where: { pid: string }; data: { level: number; policyVersionId: string } }) => {
        const row = tables.states.get(where.pid);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      },
    },
    $transaction: async <T>(arg: unknown): Promise<T> => {
      // Supports both the array form and the callback form.
      if (Array.isArray(arg)) {
        const out = [];
        for (const op of arg as Array<Promise<unknown>>) out.push(await op);
        return out as unknown as T;
      }
      return (arg as (tx: unknown) => Promise<T>)(
        {
          xpPolicyVersion: {
            create: async ({ data }: { data: { version: number; formula: unknown; maxLevel: number | null; createdBy: string } }) => {
              const row = { id: `policy-v${data.version}`, ...data };
              tables.policies.set(row.id, row);
              return row;
            },
          },
          xpLevelThreshold: {
            createMany: async ({ data }: { data: Array<{ policyVersionId: string; level: number; cumulativeXp: bigint | number }> }) => {
              const rows = data.map((d) => ({ level: d.level, cumulativeXp: Number(d.cumulativeXp) }));
              tables.thresholds.set(data[0].policyVersionId, rows);
              return { count: rows.length };
            },
          },
        } as never,
      );
    },
  } as never;
  const levels = {
    getActivePolicy: async () => {
      const policy = tables.policies.get(activeId);
      if (!policy) throw new Error("no active policy");
      return { policy, formula: policy.formula, thresholds: (tables.thresholds.get(activeId) ?? []).map((t) => ({ level: t.level, cumulativeXp: t.cumulativeXp })) };
    },
  } as never;
  // NOTE: no xpLedgerEntry delegate anywhere — any ledger write throws.
  const ledger = { reconcile: jest.fn(async () => ({ ok: true, mismatches: [] })) } as unknown as LedgerService;
  const security = { log: jest.fn(async (_pid: string, event: string, meta: unknown) => { tables.audit.push({ event, meta }); }) } as never;
  const config = { get: jest.fn((k: string, d: string) => (k === "PID_XP_MIGRATION_ENABLED" ? (opts.gate === false ? "false" : "true") : d)) } as never;
  const service = new PolicyBackfillService(prisma, levels, ledger, security, config);
  return { service, tables, ledger };
}

const pid = (i: number) => `user${String(i).padStart(3, "0")}@pid`;

describe("PolicyBackfillService (R4 migration tooling)", () => {
  it("plans: counts stamped vs pending under the target policy", async () => {
    const { service } = setup({
      states: [
        { pid: pid(1), totalXp: 50n, level: 1, policyVersionId: POLICY_A },
        { pid: pid(2), totalXp: 5000n, level: 5, policyVersionId: POLICY_A },
      ],
    });
    const plan = await service.planBackfill(POLICY_B);
    expect(plan).toMatchObject({ policyId: POLICY_B, version: 2, totalStates: 2, stamped: 0, pending: 2, isActive: false });
  });

  it("backfills in pages, stamps policyVersionId, recomputes levels — ledger untouched", async () => {
    const { service, tables } = setup({
      activeId: POLICY_B,
      states: [
        { pid: pid(1), totalXp: 50n, level: 1, policyVersionId: POLICY_A },
        { pid: pid(2), totalXp: 5000n, level: 5, policyVersionId: POLICY_A },
        { pid: pid(3), totalXp: 50000n, level: 9, policyVersionId: POLICY_A },
      ],
    });
    const p1 = await service.runBackfill("admin@pid", POLICY_B, { batchSize: 2 });
    expect(p1).toMatchObject({ processed: 2, done: false });
    expect(p1.nextCursor).toBe(pid(2));
    const p2 = await service.runBackfill("admin@pid", POLICY_B, { cursor: p1.nextCursor as string, batchSize: 2 });
    expect(p2).toMatchObject({ processed: 1, done: true, nextCursor: null });
    for (const s of tables.states.values()) expect(s.policyVersionId).toBe(POLICY_B);
    // Levels follow the NEW policy curve (base 200 — strictly harder).
    const l2 = tables.states.get(pid(2));
    expect(l2?.level).toBeLessThanOrEqual(5);
    // No ledger delegate exists on the fake: any ledger write would have thrown.
    expect(tables.audit.filter((a) => a.event === "admin.xp.backfill.ran")).toHaveLength(2);
  });

  it("re-runs are idempotent (second pass updates nothing)", async () => {
    const { service } = setup({
      activeId: POLICY_B,
      states: [{ pid: pid(1), totalXp: 50n, level: 1, policyVersionId: POLICY_B }],
    });
    // Already stamped + correctly leveled under B.
    const { tables: t2 } = setup({ activeId: POLICY_B, states: [{ pid: pid(1), totalXp: 50n, level: 1, policyVersionId: POLICY_B }] });
    void t2;
    const r = await service.runBackfill("admin@pid", POLICY_B, {});
    expect(r).toMatchObject({ processed: 1, updated: 0, done: true });
  });

  it("resumes from a cursor after a crash (checkpointed)", async () => {
    const { service, tables } = setup({
      activeId: POLICY_B,
      states: [1, 2, 3, 4, 5].map((i) => ({ pid: pid(i), totalXp: BigInt(i * 100), level: 1, policyVersionId: POLICY_A })),
    });
    const first = await service.runBackfill("admin@pid", POLICY_B, { batchSize: 2 });
    // "Crash": only the first page committed; resume with its cursor.
    const rest = await service.runBackfill("admin@pid", POLICY_B, { cursor: first.nextCursor as string, batchSize: 10 });
    expect(rest.done).toBe(true);
    expect([...tables.states.values()].every((s) => s.policyVersionId === POLICY_B)).toBe(true);
  });

  it("rollback drafts a NEW version copying the prior curve (history append-only)", async () => {
    const { service, tables } = setup({ activeId: POLICY_B });
    const r = await service.rollbackDraft("admin@pid", 1);
    expect(r).toMatchObject({ version: 3, sourceVersion: 1 });
    expect(tables.policies.get(POLICY_A)?.version).toBe(1);
    expect(tables.thresholds.get(r.policyId)).toHaveLength(THRESHOLDS_A.length);
    // Rolling back the ACTIVE version is refused (nothing to roll back to).
    await expect(service.rollbackDraft("admin@pid", 2)).rejects.toThrow("already active");
  });

  it("verifyBackfill reports ok only when reconciled AND fully stamped", async () => {
    const all = setup({ activeId: POLICY_B, states: [{ pid: pid(1), totalXp: 10n, level: 1, policyVersionId: POLICY_B }] });
    await expect(all.service.verifyBackfill()).resolves.toMatchObject({ ok: true, unstamped: 0 });

    const partial = setup({ activeId: POLICY_B, states: [{ pid: pid(1), totalXp: 10n, level: 1, policyVersionId: POLICY_A }] });
    await expect(partial.service.verifyBackfill()).resolves.toMatchObject({ ok: false, unstamped: 1 });
  });

  it("execution is release-gated (503 when disabled); planning is not", async () => {
    const { service } = setup({
      gate: false,
      states: [{ pid: pid(1), totalXp: 10n, level: 1, policyVersionId: POLICY_A }],
    });
    await expect(service.planBackfill(POLICY_B)).resolves.toMatchObject({ pending: 1 });
    await expect(service.runBackfill("admin@pid", POLICY_B, {})).rejects.toThrow(ServiceUnavailableException);
    // S2: rollback drafts version rows (a WRITE) — gated like execution.
    await expect(service.rollbackDraft("admin@pid", 1)).rejects.toThrow(ServiceUnavailableException);
  });
});
