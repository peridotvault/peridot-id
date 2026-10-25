// ANT-456 — SettingsService + XpSettingsService regression suite.
//
// Proves the fail-closed matrix (plan §5, spec F3/F4): unknown key →
// static default; type/shape mismatch → static default + warn-level alert;
// DB failure → static defaults AND intake denied with
// source="defaults-fallback". Plus: 30s cache + invalidate-on-write,
// optimistic-locking 409s, audit atomicity (SecurityEvent in the same
// txn), and the kill-switch effective-intake rule (suspend-only: the old env
// + DB intake gates are gone).

import { ConflictException } from "@nestjs/common";
import { SettingsService } from "./settings.service";
import { XpSettingsService } from "./xp-settings.service";

interface SettingRow {
  key: string;
  value: unknown;
  valueType: string;
  description: string | null;
  version: number;
  updatedBy: string;
  updatedAt: Date;
}

interface FakeTables {
  settings: Map<string, SettingRow>;
  history: Array<{ id: string; key: string; oldValue: unknown; newValue: unknown; reason: string; version: number; updatedBy: string; createdAt: Date }>;
  failReads: boolean;
  failWrites: boolean;
  reads: number;
}

function seedRow(key: string, value: unknown, valueType: string, version = 1): SettingRow {
  return { key, value, valueType, description: `${key} desc`, version, updatedBy: "seed", updatedAt: new Date("2026-10-23T00:00:00Z") };
}

function setup(opts: { rows?: SettingRow[]; failReads?: boolean; failWrites?: boolean } = {}) {
  const tables: FakeTables = {
    settings: new Map((opts.rows ?? []).map((r) => [r.key, { ...r }])),
    history: [],
    failReads: opts.failReads ?? false,
    failWrites: opts.failWrites ?? false,
    reads: 0,
  };
  const maybeFailRead = () => {
    if (tables.failReads) throw new Error("db down");
  };
  const maybeFailWrite = () => {
    if (tables.failWrites) throw new Error("db down");
  };
  const delegates = {
    systemSetting: {
      findUnique: async ({ where, select }: { where: { key: string }; select?: Record<string, boolean> }) => {
        tables.reads++;
        maybeFailRead();
        const row = tables.settings.get(where.key) ?? null;
        if (!row || !select) return row ? { ...row } : null;
        return Object.fromEntries(Object.entries(row).filter(([k]) => select[k]));
      },
      findUniqueOrThrow: async ({ where }: { where: { key: string } }) => {
        tables.reads++;
        maybeFailRead();
        const row = tables.settings.get(where.key);
        if (!row) throw new Error("not found");
        return { ...row };
      },
      findMany: async ({ where, orderBy }: { where?: { key?: { startsWith?: string } }; orderBy?: { key: string } } = {}) => {
        void orderBy;
        tables.reads++;
        maybeFailRead();
        const prefix = where?.key?.startsWith;
        return [...tables.settings.values()]
          .filter((r) => !prefix || r.key.startsWith(prefix))
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((r) => ({ ...r }));
      },
      updateMany: async ({ where, data }: { where: { key: string; version: number }; data: Record<string, unknown> }) => {
        maybeFailWrite();
        const row = tables.settings.get(where.key);
        if (!row || row.version !== where.version) return { count: 0 };
        tables.settings.set(where.key, { ...row, ...(data as Partial<SettingRow>), updatedAt: new Date() });
        return { count: 1 };
      },
    },
    systemSettingHistory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        maybeFailWrite();
        const row = { id: `h-${tables.history.length + 1}`, createdAt: new Date(), ...data } as FakeTables["history"][number];
        tables.history.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, skip, take }: { where: { key: string }; orderBy?: unknown; skip?: number; take?: number }) => {
        void orderBy;
        tables.reads++;
        maybeFailRead();
        const rows = tables.history.filter((h) => h.key === where.key);
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length)).map((r) => ({ ...r }));
      },
    },
  };
  const prisma = {
    ...delegates,
    $transaction: async <T>(fn: (tx: typeof delegates) => Promise<T>): Promise<T> => fn(delegates),
  };
  const audit: Array<{ pid: string; event: string; meta: unknown; inTxn: boolean }> = [];
  const security = {
    log: jest.fn(async (pid: string, event: string, meta: unknown, tx?: unknown) => {
      audit.push({ pid, event, meta, inTxn: tx === delegates });
    }),
  };
  const alerts: Array<{ key: string; reason: string; detail?: string }> = [];
  const service = new SettingsService(prisma as never, security as never);
  service.onAlert = (info) => alerts.push({ ...info });
  return { service, tables, prisma, security, audit, alerts };
}

const SEEDED = () => [
  seedRow("xp.suspend.global", true, "boolean"),
  seedRow("xp.suspend.app-1", false, "boolean"),
  seedRow("xp.limits.daily", 1000, "integer"),
  seedRow("xp.policy.active", "v2", "string"),
  seedRow("xp.policy.thresholds", { bronze: 100 }, "json"),
];

describe("SettingsService fail-closed matrix", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the DB value on a hit", async () => {
    const { service } = setup({ rows: SEEDED() });
    await expect(service.get<boolean>("xp.suspend.global", false)).resolves.toBe(true);
  });

  it("unknown key resolves to the static default without alerting", async () => {
    const { service, alerts } = setup({ rows: SEEDED() });
    await expect(service.get<boolean>("xp.suspend.missing", false)).resolves.toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("type mismatch falls back to the static default and fires the alert hook", async () => {
    const { service, alerts } = setup({ rows: [seedRow("xp.suspend.global", "yes", "string")] });
    await expect(service.get<boolean>("xp.suspend.global", false)).resolves.toBe(false);
    expect(alerts).toEqual([{ key: "xp.suspend.global", reason: "type_mismatch", detail: expect.stringContaining("catalog") }]);
  });

  it("semantic violation (negative limit) falls back with an alert", async () => {
    const { service, alerts } = setup({ rows: [seedRow("xp.limits.daily", -5, "integer")] });
    await expect(service.get<number>("xp.limits.daily", 0)).resolves.toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ key: "xp.limits.daily", reason: "type_mismatch" });
  });

  it("DB read failure falls back to the static default with a db_error alert", async () => {
    const { service, alerts } = setup({ rows: SEEDED(), failReads: true });
    await expect(service.get<boolean>("xp.suspend.global", false)).resolves.toBe(false);
    expect(alerts).toEqual([{ key: "xp.suspend.global", reason: "db_error", detail: "db down" }]);
  });

  it("caches reads for 30s and invalidates on admin write", async () => {
    const { service, tables } = setup({ rows: SEEDED() });
    await service.get<boolean>("xp.suspend.global", false);
    await service.get<boolean>("xp.suspend.global", false);
    expect(tables.reads).toBe(1);
    await service.updateSetting("xp.suspend.global", false, { reason: "disable intake for maintenance window", expectedVersion: 1, updatedBy: "admin@pid" });
    const readsBefore = tables.reads;
    await service.get<boolean>("xp.suspend.global", true);
    // Cache was invalidated by the write: the read hits the DB again.
    expect(tables.reads).toBe(readsBefore + 1);
  });

  it("admin write bumps version, writes history, and audits in the same txn", async () => {
    const { service, tables, security, audit } = setup({ rows: SEEDED() });
    const updated = await service.updateSetting("xp.suspend.global", false, {
      reason: "disable intake for maintenance window",
      expectedVersion: 1,
      updatedBy: "admin@pid",
    });
    expect(updated).toMatchObject({ key: "xp.suspend.global", value: false, version: 2, updatedBy: "admin@pid" });
    expect(tables.settings.get("xp.suspend.global")?.version).toBe(2);
    expect(tables.history).toHaveLength(1);
    expect(tables.history[0]).toMatchObject({ key: "xp.suspend.global", oldValue: true, newValue: false, version: 2, updatedBy: "admin@pid" });
    expect(security.log).toHaveBeenCalledTimes(1);
    expect(audit[0]).toMatchObject({ pid: "admin@pid", event: "system_setting.updated", inTxn: true });
    expect(audit[0].meta).toMatchObject({ key: "xp.suspend.global", oldValue: true, newValue: false, version: 2 });
  });

  it("stale expectedVersion loses with 409 carrying current state (optimistic locking)", async () => {
    const { service } = setup({ rows: SEEDED() });
    await service.updateSetting("xp.suspend.global", false, { reason: "first writer wins here", expectedVersion: 1, updatedBy: "admin@pid" });
    const err = await service
      .updateSetting("xp.suspend.global", true, { reason: "second writer loses here", expectedVersion: 1, updatedBy: "admin@pid" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ error: "version_conflict", current: { value: false, version: 2 } });
  });

  it("invalid value shape is a 400 validation_error stating the constraint", async () => {
    const { service, security } = setup({ rows: SEEDED() });
    const err = await service
      .updateSetting("xp.limits.daily", -1, { reason: "negative cap attempt by admin", expectedVersion: 1, updatedBy: "admin@pid" })
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ error: "validation_error", message: expect.stringContaining("integer >= 0") });
    expect(security.log).not.toHaveBeenCalled();
  });

  it("short reason is a 400 validation_error (reason-required writes)", async () => {
    const { service } = setup({ rows: SEEDED() });
    const err = await service
      .updateSetting("xp.suspend.global", false, { reason: "short", expectedVersion: 1, updatedBy: "admin@pid" })
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ error: "validation_error", message: expect.stringContaining("reason") });
  });

  it("unknown key write is a 404 (closed catalog)", async () => {
    const { service } = setup({ rows: SEEDED() });
    const err = await service
      .updateSetting("xp.rewards.some_task", { amount: 5, cap: null }, { reason: "typo key must not create rows", expectedVersion: 1, updatedBy: "admin@pid" })
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ error: "not_found" });
  });

  it("list filters by prefix; unknown prefix is an empty happy path", async () => {
    const { service } = setup({ rows: SEEDED() });
    const xp = await service.listSettings("xp.");
    expect(xp.map((s) => s.key)).toEqual([...xp.map((s) => s.key)].sort());
    expect(xp.length).toBeGreaterThan(0);
    await expect(service.listSettings("nope.")).resolves.toEqual([]);
  });

  it("history returns newest entries with reason/actor and a next cursor", async () => {
    const { service } = setup({ rows: SEEDED() });
    await service.updateSetting("xp.suspend.global", false, { reason: "first reason for history view", expectedVersion: 1, updatedBy: "admin@pid" });
    const page = await service.settingHistory("xp.suspend.global", { limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ version: 2, oldValue: true, newValue: false, updatedBy: "admin@pid" });
    expect(page.nextCursor).toBeNull();
  });
});

describe("XpSettingsService effective intake (kill-switch only)", () => {
  const matrix: Array<{ name: string; suspendGlobal: boolean; suspendApp: boolean; want: boolean }> = [
    { name: "nothing suspended → open", suspendGlobal: false, suspendApp: false, want: true },
    { name: "global suspend → closed", suspendGlobal: true, suspendApp: false, want: false },
    { name: "app suspend → closed for that app", suspendGlobal: false, suspendApp: true, want: false },
  ];

  it.each(matrix)("$name", async ({ suspendGlobal, suspendApp, want }) => {
    const { service } = setup({
      rows: [seedRow("xp.suspend.global", suspendGlobal, "boolean"), seedRow("xp.suspend.app-1", suspendApp, "boolean")],
    });
    const xp = new XpSettingsService(service);
    const result = await xp.effectiveIntake("app-1");
    expect(result.allowed).toBe(want);
    expect(result.breakdown).toEqual({ suspendGlobal, suspendApp });
    expect(result.source).toBe("db");
  });

  it("per-app suspend scopes to that app", async () => {
    const { service } = setup({
      rows: [seedRow("xp.suspend.global", false, "boolean"), seedRow("xp.suspend.app-1", true, "boolean")],
    });
    const xp = new XpSettingsService(service);
    await expect(xp.effectiveIntake("app-1")).resolves.toMatchObject({ allowed: false });
    await expect(xp.effectiveIntake("app-2")).resolves.toMatchObject({ allowed: true });
  });

  it("absent keys leave intake open (no release gate anymore)", async () => {
    const { service } = setup({ rows: [] });
    const xp = new XpSettingsService(service);
    await expect(xp.effectiveIntake("app-1")).resolves.toEqual({
      allowed: true,
      breakdown: { suspendGlobal: false, suspendApp: false },
      source: "db",
    });
  });

  it("DB outage denies with source=defaults-fallback (B5)", async () => {
    const { service } = setup({ rows: SEEDED(), failReads: true });
    const xp = new XpSettingsService(service);
    const result = await xp.effectiveIntake("app-1");
    expect(result).toMatchObject({ allowed: false, source: "defaults-fallback" });
  });

  it("absent app-permission keys deny by default", async () => {
    const { service } = setup({ rows: SEEDED() });
    const xp = new XpSettingsService(service);
    await expect(xp.getAppPermissions("ghost-app")).resolves.toEqual({ canEarn: false, canSpend: false });
    await expect(xp.getReward("ghost_task")).resolves.toBeNull();
  });
});
