import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SubmitEventDto } from "./events.dto";
import { EvidenceService } from "./evidence.service";
import { EventsService } from "./events.service";
import { LedgerService } from "./ledger.service";
import { QuotaService } from "./quota.service";
import { VerificationService } from "./verification.service";
import { buildThresholds, DEFAULT_FORMULA } from "./xp-curve";

/**
 * ANT-89 M3 (ANT-441) — intake pipeline regression suite.
 *
 * In-memory Prisma stand-in emulating the production concurrency contract:
 * SELECT ... FOR UPDATE serializes per (state, quota, org) key (per-key
 * mutex held to txn end); unique(appId,eventId) raises P2002 on concurrent
 * double-insert; whole-txn serialization is NOT assumed — interleaving
 * happens at every await, like the real driver.
 *
 * Every checklist item carries a failing-before/passing-after regression:
 * dedup race (W2a), cap race (W2b), revocation-mid-flight (F2),
 * reconcile (R2), no-oracle envelope (F5), no-xp-field (F6), checker
 * fail-closed (R3), kill-switch deny path.
 */
const POLICY_ID = "policy-m3";
const ACTIVE = {
  policy: { id: POLICY_ID },
  formula: DEFAULT_FORMULA,
  thresholds: buildThresholds(100, DEFAULT_FORMULA),
};
const levelsMock = { getActivePolicy: jest.fn(async () => ACTIVE) } as never;

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });

const tick = () => new Promise<void>((r) => setImmediate(r));

interface FakeTables {
  apps: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  identities: Map<string, { pid: string; status: string }>;
  profiles: Set<string>;
  credentialCounts: Map<string, number>;
  states: Map<string, { pid: string; totalXp: bigint; level: number; policyVersionId: string }>;
  completions: Map<string, Record<string, unknown>>;
  entries: Array<{ id: string; pid: string; deltaXp: bigint; appId: string | null; eventId: string | null; kind: string }>;
  quotas: Map<string, Record<string, unknown>>;
  orgQuotas: Map<string, Record<string, unknown>>;
  suspicious: Array<{ signal: string; pid: string | null; appId: string | null; detail: unknown }>;
  /**
   * S1 test hook: when true, the app row reads permitted ONCE then revoked
   * (xpEnabled=false) — emulates an admin revoke landing mid-flight between
   * the pre-lock predicate read and the post-lock re-verification.
   */
  revokeAfterFirstAppRead: boolean;
  appReads: number;
  /**
   * S1 test hook (task half): when true, the task row reads active ONCE
   * (pre-lock findMany) then disabled — emulates an admin disabling the
   * task mid-flight between predicate read and post-lock re-verification.
   */
  disableTaskAfterFirstTaskRead: boolean;
  taskReads: number;
}

const completionKey = (appId: string, eventId: string) => JSON.stringify([appId, eventId]);

function fakePrisma(tables: FakeTables) {
  const locks = new Map<string, Promise<void>>();
  const acquire = async (key: string): Promise<() => void> => {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((r) => (release = r));
    locks.set(key, prev.then(() => cur));
    await prev;
    return () => {
      release();
      if (locks.get(key)) locks.delete(key);
    };
  };

  const parseLock = (sql: { strings?: unknown; values?: unknown[] }) => {
    const text = Array.isArray(sql.strings) ? (sql.strings as string[]).join("?") : "";
    const key = String(sql.values?.[0] ?? "");
    if (text.includes("user_xp_states")) return { domain: "state", key, row: tables.states.get(key) ? [{ pid: key }] : [] };
    if (text.includes("xp_org_quotas")) return { domain: "org", key, row: tables.orgQuotas.get(key) ? [{ ownerPid: key }] : [] };
    if (text.includes("xp_quotas")) return { domain: "quota", key, row: tables.quotas.get(key) ? [{ appId: key }] : [] };
    throw new Error(`unexpected lock query: ${text}`);
  };

  const entrySums = (appIds: string[], gte: Date) => {
    let sum = 0n;
    for (const e of tables.entries) {
      void e;
      const row = e as { appId: string | null; createdAt?: Date; deltaXp: bigint };
      if (row.appId && appIds.includes(row.appId) && row.createdAt && row.createdAt >= gte) sum += row.deltaXp;
    }
    return sum;
  };

  const txFace = (releases: Array<() => void>) => ({
    $queryRaw: async (sql: { strings?: unknown; values?: unknown[] }) => {
      await tick();
      const lock = parseLock(sql);
      if (lock.row.length > 0) releases.push(await acquire(`${lock.domain}:${lock.key}`));
      await tick();
      return lock.row;
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
    },
    pidApp: {
      findUnique: async ({ where }: { where: { id: string } | { clientId: string } }) => {
        await tick();
        if ("id" in where) {
          const row = tables.apps.get(where.id) ?? null;
          // S1 hook: first read sees the permitted app; later reads see the
          // admin revoke that landed mid-flight.
          if (row && tables.revokeAfterFirstAppRead && ++tables.appReads > 1) {
            return { ...row, xpEnabled: false };
          }
          return row;
        }
        return [...tables.apps.values()].find((a) => a.clientId === (where as { clientId: string }).clientId) ?? null;
      },
      findMany: async ({ where }: { where: { ownerPid: string } }) => {
        await tick();
        return [...tables.apps.values()].filter((a) => a.ownerPid === where.ownerPid).map((a) => ({ id: a.id }));
      },
    },
    xpTask: {
      findMany: async ({ where }: { where: { key: string; status: string } }) => {
        await tick();
        tables.taskReads++;
        return [...tables.tasks.values()].filter((t) => t.key === where.key && t.status === where.status);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        await tick();
        const row = tables.tasks.get(where.id) ?? null;
        // S1 hook: pre-lock read sees the active task; the post-lock
        // re-verification (findUnique by id) sees the admin disable.
        if (row && tables.disableTaskAfterFirstTaskRead && ++tables.taskReads > 1) {
          return { ...row, status: "disabled" };
        }
        return row;
      },
    },
    identity: {
      findUnique: async ({ where }: { where: { pid: string } }) => {
        await tick();
        return tables.identities.get(where.pid) ?? null;
      },
    },
    profile: {
      findUnique: async ({ where }: { where: { pid: string } }) => {
        await tick();
        return tables.profiles.has(where.pid) ? { pid: where.pid } : null;
      },
    },
    identityCredential: {
      count: async ({ where }: { where: { pid: string } }) => {
        await tick();
        return tables.credentialCounts.get(where.pid) ?? 0;
      },
    },
    xpTaskCompletion: {
      findUnique: async ({ where }: { where: { appId_eventId: { appId: string; eventId: string } } }) => {
        await tick();
        return tables.completions.get(completionKey(where.appId_eventId.appId, where.appId_eventId.eventId)) ?? null;
      },
      findFirst: async ({ where, orderBy }: { where: { taskId: string; pid: string }; orderBy: { createdAt: string } }) => {
        await tick();
        const rows = [...tables.completions.values()]
          .filter((c) => c.taskId === where.taskId && c.pid === where.pid)
          .sort((a, b) => (orderBy.createdAt === "desc" ? +new Date(b.createdAt as string) - +new Date(a.createdAt as string) : 0));
        return rows[0] ?? null;
      },
      count: async ({ where }: { where: { taskId: string; pid: string; createdAt?: { gte: Date } } }) => {
        await tick();
        return [...tables.completions.values()].filter(
          (c) => c.taskId === where.taskId && c.pid === where.pid && (!where.createdAt || new Date(c.createdAt as string) >= where.createdAt.gte),
        ).length;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        await tick();
        const key = completionKey(String(data.appId ?? ""), String(data.eventId));
        if (tables.completions.has(key)) throw p2002(["appId", "eventId"]);
        const row = { ...data, createdAt: new Date().toISOString() };
        tables.completions.set(key, row);
        return row;
      },
    },
    xpQuota: {
      findUnique: async ({ where }: { where: { appId: string } }) => {
        await tick();
        return tables.quotas.get(where.appId) ?? null;
      },
    },
    xpOrgQuota: {
      findUnique: async ({ where }: { where: { ownerPid: string } }) => {
        await tick();
        return tables.orgQuotas.get(where.ownerPid) ?? null;
      },
    },
    xpLedgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        await tick();
        const row = {
          id: `e${tables.entries.length + 1}`,
          pid: data.pid,
          deltaXp: data.deltaXp,
          appId: (data.appId as string | null) ?? null,
          eventId: (data.eventId as string | null) ?? null,
          kind: data.kind,
          createdAt: new Date(),
        } as unknown as FakeTables["entries"][number] & { createdAt: Date };
        tables.entries.push(row as never);
        return { ...row, balanceAfter: data.balanceAfter, levelAfter: data.levelAfter };
      },
      aggregate: async ({ where }: { where: { appId: string | { in: string[] }; createdAt: { gte: Date } } }) => {
        await tick();
        const ids = typeof where.appId === "string" ? [where.appId] : where.appId.in;
        return { _sum: { deltaXp: entrySums(ids, where.createdAt.gte) } };
      },
      groupBy: async ({ where }: { where?: { pid?: string } } = {}) => {
        await tick();
        const sums = new Map<string, bigint>();
        for (const e of tables.entries) {
          if (where?.pid && e.pid !== where.pid) continue;
          sums.set(e.pid, (sums.get(e.pid) ?? 0n) + e.deltaXp);
        }
        return [...sums.entries()].map(([pid, total]) => ({ pid, _sum: { deltaXp: total } }));
      },
    },
    xpSuspiciousActivity: {
      create: async ({ data }: { data: { signal: string; pid: string | null; appId: string | null; detail: unknown } }) => {
        await tick();
        tables.suspicious.push({ signal: data.signal, pid: data.pid, appId: data.appId, detail: data.detail });
        return { id: `s${tables.suspicious.length}`, ...data };
      },
    },
  });

  const rootSuspicious = {
    create: async ({ data }: { data: { signal: string; pid: string | null; appId: string | null; detail: unknown } }) => {
      tables.suspicious.push({ signal: data.signal, pid: data.pid, appId: data.appId, detail: data.detail });
      return { id: `s${tables.suspicious.length}`, ...data };
    },
  };

  const root = {
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
      findMany: async ({ where }: { where?: { pid: { in: string[] } } } = {}) => {
        const rows = [...tables.states.values()];
        return where?.pid?.in ? rows.filter((r) => where.pid!.in.includes(r.pid)) : rows;
      },
    },
    xpTaskCompletion: {
      findUnique: async ({ where }: { where: { appId_eventId: { appId: string; eventId: string } } }) =>
        tables.completions.get(completionKey(where.appId_eventId.appId, where.appId_eventId.eventId)) ?? null,
    },
    xpSuspiciousActivity: rootSuspicious,
    xpLedgerEntry: {
      groupBy: async ({ where }: { where?: { pid?: string } } = {}) => {
        const sums = new Map<string, bigint>();
        for (const e of tables.entries) {
          if (where?.pid && e.pid !== where.pid) continue;
          sums.set(e.pid, (sums.get(e.pid) ?? 0n) + e.deltaXp);
        }
        return [...sums.entries()].map(([pid, total]) => ({ pid, _sum: { deltaXp: total } }));
      },
    },
  } as never;
  return root;
}

const APP = { id: "app-1", clientId: "pidapp_test", ownerPid: "owner@pid", isActive: true, isVerified: true, xpEnabled: true, approvedEventTypes: ["onboarding_completed", "campaign_completed"] };
const AUTHED = { id: APP.id, clientId: APP.clientId, ownerPid: APP.ownerPid, isVerified: true, xpEnabled: true, approvedEventTypes: [...APP.approvedEventTypes] };

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-onboarding",
    key: "onboarding_completed",
    xpReward: 20,
    recurring: "unlimited",
    lifetimeLimit: null,
    dailyLimit: null,
    weeklyLimit: null,
    monthlyLimit: null,
    cooldownSecs: null,
    availableFrom: null,
    availableUntil: null,
    verificationType: "internal_state",
    verificationChecker: "internal_state.onboarding_completed",
    scopeAppId: null,
    status: "active",
    ...overrides,
  };
}

function setup(opts: { tasks?: Array<Record<string, unknown>>; app?: Record<string, unknown>; suspended?: boolean; settingsThrow?: boolean; revokeAfterFirstRead?: boolean; disableTaskAfterFirstRead?: boolean } = {}) {
  const tables: FakeTables = {
    apps: new Map([[APP.id, { ...APP, ...(opts.app ?? {}) }]]),
    tasks: new Map(),
    identities: new Map([["user@pid", { pid: "user@pid", status: "active" }]]),
    profiles: new Set(["user@pid"]),
    credentialCounts: new Map([["user@pid", 1]]),
    states: new Map(),
    completions: new Map(),
    entries: [],
    quotas: new Map(),
    orgQuotas: new Map(),
    suspicious: [],
    revokeAfterFirstAppRead: opts.revokeAfterFirstRead ?? false,
    appReads: 0,
    disableTaskAfterFirstTaskRead: opts.disableTaskAfterFirstRead ?? false,
    taskReads: 0,
  };
  for (const t of opts.tasks ?? [taskRow()]) tables.tasks.set(String(t.id), t);
  const prisma = fakePrisma(tables);
  const security = { log: jest.fn(async () => undefined) };
  // Effective intake is kill-switch only (xp.suspend.*). Default stub leaves
  // intake open so pre-existing tests exercise the pipeline; opts.suspended=true
  // and opts.settingsThrow=true drive the two fail-closed paths.
  const xpSettings = {
    effectiveIntake: jest.fn(async () => {
      if (opts.settingsThrow) throw new Error("settings store unreachable");
      const suspendGlobal = opts.suspended === true;
      return {
        allowed: !suspendGlobal,
        breakdown: { suspendGlobal, suspendApp: false },
        source: "db",
      };
    }),
  };
  const ledger = new LedgerService(prisma as never, levelsMock);
  const service = new EventsService(
    prisma as never,
    levelsMock,
    ledger,
    new VerificationService(),
    new QuotaService(),
    new EvidenceService(),
    security as never,
    xpSettings as never,
  );
  return { service, tables, prisma, security, ledger, xpSettings };
}

function dtoFor(overrides: Record<string, unknown> = {}): SubmitEventDto {
  // Real DTO instances (class-validator shape): note the absence of any
  // xp/amount key — F6 regression: the intake contract cannot carry XP.
  const dto = Object.assign(new SubmitEventDto(), {
    client_id: APP.clientId,
    client_secret: "pidsk_secret",
    event_id: "evt-1",
    user_id: "user@pid",
    event_type: "onboarding_completed",
    ...overrides,
  });
  expect("xp" in dto && (dto as Record<string, unknown>).xp !== undefined).toBe(false);
  return dto;
}

describe("EventsService pipeline", () => {
  beforeEach(() => jest.clearAllMocks());

  it("awards XP from the server-side task reward (never a client amount)", async () => {
    const { service, tables, security } = setup();
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "awarded", awarded_xp: 20, leveledUp: false });
    expect(tables.entries).toHaveLength(1);
    expect(tables.entries[0]).toMatchObject({ pid: "user@pid", deltaXp: 20n, appId: "app-1", kind: "task_award" });
    expect(tables.states.get("user@pid")).toMatchObject({ totalXp: 20n, level: 1, policyVersionId: POLICY_ID });
    expect(security.log).toHaveBeenCalledWith("user@pid", "xp.awarded", expect.objectContaining({ taskId: "task-onboarding" }), expect.anything());
  });

  it("levels up across the L1→L2 band edge (server-side reward)", async () => {
    const { service } = setup({ tasks: [taskRow({ xpReward: 150 })] });
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "awarded", awarded_xp: 150, level: 2, leveledUp: true });
  });

  it("duplicate event_id returns duplicate without a second award", async () => {
    const { service, tables } = setup();
    const first = await service.submitEvent(dtoFor(), { ...AUTHED });
    const second = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(first.status).toBe("awarded");
    expect(second).toMatchObject({ status: "duplicate", awarded_xp: 0 });
    expect(tables.entries).toHaveLength(1);
  });

  it("N-parallel identical events award EXACTLY once (W2a race)", async () => {
    const { service, tables } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.submitEvent(dtoFor(), { ...AUTHED })),
    );
    const awarded = results.filter((r) => r.status === "awarded");
    const duplicates = results.filter((r) => r.status === "duplicate");
    expect(awarded).toHaveLength(1);
    expect(duplicates).toHaveLength(9);
    expect(tables.entries).toHaveLength(1);
    expect(tables.states.get("user@pid")?.totalXp).toBe(20n);
  });

  it("N-parallel distinct events over a cap credit AT MOST the cap (W2b race + waiver W2)", async () => {
    const { service, tables } = setup({ tasks: [taskRow({ xpReward: 20 })] });
    tables.quotas.set("app-1", { appId: "app-1", dailyCap: 100, weeklyCap: null, monthlyCap: null, suspended: false, suspendReason: null });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.submitEvent(dtoFor({ event_id: `evt-${i}` }), { ...AUTHED })),
    );
    const awarded = results.filter((r) => r.status === "awarded");
    const rejected = results.filter((r) => r.status === "rejected");
    const credited = awarded.reduce((n, r) => n + r.awarded_xp, 0);
    expect(credited).toBeLessThanOrEqual(100);
    expect(credited).toBe(100);
    expect(awarded).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((r) => r.reason === "quota_exceeded")).toBe(true);
  });

  it("revoke landing mid-flight still blocks THIS award (S1 post-lock recheck)", async () => {
    // The guard + pre-lock read see the permitted app; the admin revoke
    // lands before the post-lock re-verification → zero awards, and the
    // feed marks the recheck (not the initial check) as the blocker.
    const { service, tables } = setup({ revokeAfterFirstRead: true });
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "rejected", reason: "app_not_permitted" });
    expect(tables.entries).toHaveLength(0);
    expect(
      tables.suspicious.some(
        (s) => s.signal === "xp.intake.permission_denied" && (s.detail as { recheck?: boolean }).recheck === true,
      ),
    ).toBe(true);
  });

  it("task disabled mid-flight still blocks THIS award (S1 post-lock task recheck)", async () => {
    // Pre-lock resolution sees the active task; the admin disable lands
    // before the post-lock re-verification → zero awards, and the feed
    // marks the recheck as the blocker.
    const { service, tables } = setup({ disableTaskAfterFirstRead: true });
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "rejected", reason: "no_active_task" });
    expect(tables.entries).toHaveLength(0);
    expect(
      tables.suspicious.some(
        (s) => s.signal === "xp.intake.checker_drift" && (s.detail as { recheck?: boolean }).recheck === true,
      ),
    ).toBe(true);
  });

  it("revocation-mid-flight yields ZERO post-revoke awards (F2 TOCTOU)", async () => {
    const { service, tables } = setup();
    // Guard passed while the app was permitted; admin revokes before the txn.
    tables.apps.set(APP.id, { ...APP, xpEnabled: false });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => service.submitEvent(dtoFor({ event_id: `evt-r${i}` }), { ...AUTHED })),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(tables.entries).toHaveLength(0);
    expect(tables.suspicious.some((s) => s.signal === "xp.intake.permission_denied")).toBe(true);
  });

  it("task disabled-mid-flight is re-read and rejected (F2)", async () => {
    const { service, tables } = setup();
    tables.tasks.set("task-onboarding", taskRow({ status: "disabled" }));
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "rejected", reason: "no_active_task" });
    expect(tables.entries).toHaveLength(0);
  });

  it("unverified / XP-disabled / unapproved apps get permission rejections (logged)", async () => {
    const { service, tables } = setup();
    tables.apps.set(APP.id, { ...APP, isVerified: false });
    const v = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(v).toMatchObject({ status: "rejected", reason: "app_not_permitted" });

    tables.apps.set(APP.id, { ...APP, xpEnabled: false });
    const x = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(x).toMatchObject({ status: "rejected", reason: "app_not_permitted" });

    tables.apps.set(APP.id, { ...APP });
    const t = await service.submitEvent(dtoFor({ event_type: "ecosystem_activity" }), { ...AUTHED });
    expect(t).toMatchObject({ status: "rejected", reason: "app_not_permitted" });
    expect(tables.entries).toHaveLength(0);
    expect(tables.suspicious.filter((s) => s.signal === "xp.intake.permission_denied")).toHaveLength(3);
  });

  it("unknown subject and failed verification share ONE reason (F5: no PID oracle)", async () => {
    const { service } = setup({
      tasks: [taskRow(), taskRow({ id: "task-campaign", key: "campaign_completed", verificationChecker: "internal_state.campaign_verified" })],
    });
    const ghost = await service.submitEvent(dtoFor({ user_id: "ghost@pid" }), { ...AUTHED });
    // Live user, but the campaign checker has no PeridotID-side record (R3 fail-closed).
    const unverifiable = await service.submitEvent(dtoFor({ event_type: "campaign_completed", event_id: "evt-c1" }), { ...AUTHED });
    expect(ghost).toMatchObject({ status: "rejected", reason: "not_eligible" });
    expect(unverifiable).toMatchObject({ status: "rejected", reason: "not_eligible" });
    expect(ghost.reason).toBe(unverifiable.reason);
  });

  it("malformed user_id is 400 (format validation reveals nothing)", async () => {
    const { service } = setup();
    await expect(service.submitEvent(dtoFor({ user_id: "notapid" }), { ...AUTHED })).rejects.toThrow("user_id must be a valid PID");
  });

  it("once-tasks reject the second DISTINCT event (task_limit)", async () => {
    const { service } = setup({ tasks: [taskRow({ recurring: "once" })] });
    const first = await service.submitEvent(dtoFor(), { ...AUTHED });
    const second = await service.submitEvent(dtoFor({ event_id: "evt-2" }), { ...AUTHED });
    expect(first.status).toBe("awarded");
    expect(second).toMatchObject({ status: "rejected", reason: "task_limit" });
  });

  it("cooldowns reject rapid re-submits", async () => {
    const { service } = setup({ tasks: [taskRow({ recurring: "unlimited", cooldownSecs: 3600 })] });
    const first = await service.submitEvent(dtoFor(), { ...AUTHED });
    const second = await service.submitEvent(dtoFor({ event_id: "evt-2" }), { ...AUTHED });
    expect(first.status).toBe("awarded");
    expect(second).toMatchObject({ status: "rejected", reason: "cooldown" });
  });

  it("suspended apps and app-scoped tasks resolve correctly", async () => {
    const { service, tables } = setup({
      tasks: [taskRow({ id: "task-scoped", scopeAppId: "app-1" }), taskRow({ id: "task-eco", scopeAppId: null })],
    });
    tables.quotas.set("app-1", { appId: "app-1", dailyCap: null, weeklyCap: null, monthlyCap: null, suspended: true, suspendReason: "abuse" });
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "rejected", reason: "suspended" });
    expect(tables.suspicious.some((s) => s.signal === "xp.intake.quota_exceeded")).toBe(true);
  });

  it("kill-switch: a global suspend refuses with 503 and writes the feed", async () => {
    const { service, tables } = setup({ suspended: true });
    await expect(service.submitEvent(dtoFor(), { ...AUTHED })).rejects.toThrow(ServiceUnavailableException);
    expect(tables.entries).toHaveLength(0);
    expect(tables.suspicious.some((s) => s.signal === "xp.intake.disabled_reject")).toBe(true);
  });

  it("effective intake: suspend denies and the feed carries the breakdown", async () => {
    const { service, tables, xpSettings } = setup({ suspended: true });
    await expect(service.submitEvent(dtoFor(), { ...AUTHED })).rejects.toThrow(ServiceUnavailableException);
    expect(tables.entries).toHaveLength(0);
    expect(xpSettings.effectiveIntake).toHaveBeenCalledWith("app-1");
    const feed = tables.suspicious.find((s) => s.signal === "xp.intake.disabled_reject");
    expect(feed).toBeDefined();
    expect(feed?.detail).toMatchObject({ suspendGlobal: true, suspendApp: false, source: "db" });
  });

  it("fail-closed: a throwing settings layer still denies with 503", async () => {
    const { service, tables } = setup({ settingsThrow: true });
    await expect(service.submitEvent(dtoFor(), { ...AUTHED })).rejects.toThrow(ServiceUnavailableException);
    expect(tables.entries).toHaveLength(0);
    expect(tables.suspicious.some((s) => s.signal === "xp.intake.disabled_reject")).toBe(true);
  });

  it("ledger reconciles after awards (R2 recovery primitive)", async () => {
    const { service, ledger, prisma } = setup();
    await service.submitEvent(dtoFor(), { ...AUTHED });
    await service.submitEvent(dtoFor({ event_id: "evt-2" }), { ...AUTHED });
    const verdict = await ledger.reconcile();
    expect(verdict).toEqual({ ok: true, mismatches: [] });
    void prisma;
  });

  it("org quota breach rejects without writing (org aggregate enforced)", async () => {
    const { service, tables } = setup();
    tables.orgQuotas.set("owner@pid", { ownerPid: "owner@pid", dailyCap: 10, weeklyCap: null, monthlyCap: null });
    const r = await service.submitEvent(dtoFor(), { ...AUTHED });
    expect(r).toMatchObject({ status: "rejected", reason: "quota_exceeded" });
    expect(tables.entries).toHaveLength(0);
  });
});
