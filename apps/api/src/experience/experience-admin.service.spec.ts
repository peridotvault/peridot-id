import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { validateChecker, validateEventTypeAllowlist } from "./catalog";
import { ExperienceAdminController } from "./experience-admin.controller";
import { checkGrantEnvelope, ExperienceAdminService } from "./experience-admin.service";
import { LedgerService } from "./ledger.service";
import { buildThresholds, DEFAULT_FORMULA } from "./xp-curve";

const ADMIN = "admin@pid";
const APP_ID = "app-1";

function serviceWith(prisma: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const security = { log: jest.fn(async () => undefined) };
  const levels = { getActivePolicy: jest.fn(async () => ({ policy: { id: "p1", version: 1 }, formula: DEFAULT_FORMULA, thresholds: buildThresholds(100, DEFAULT_FORMULA) })) };
  const ledger = { adjustXp: jest.fn(), reverseXp: jest.fn() };
  const svc = new ExperienceAdminService(prisma as never, levels as never, ledger as never, security as never);
  return { svc, security: security as { log: jest.Mock }, levels, ledger: ledger as { adjustXp: jest.Mock; reverseXp: jest.Mock }, ...(overrides as object) };
}

const APP_ROW = {
  id: APP_ID,
  clientId: "client-1",
  ownerPid: "owner@pid",
  xpEnabled: false,
  approvedEventTypes: [],
};

describe("catalog validators (C3/F8 pure rules)", () => {
  it("C3: unknown event type is rejected (nothing persisted by caller)", () => {
    const r = validateEventTypeAllowlist(["campaign_completed", "mint_xp"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(";")).toMatch(/not in MVP catalog/);
  });

  it("C3: bad format is rejected", () => {
    for (const bad of ["Has-Caps", "x", "a".repeat(65), "has space", "UPPER"]) {
      const r = validateEventTypeAllowlist([bad]);
      expect(r.ok).toBe(false);
    }
  });

  it("C3: duplicates are rejected", () => {
    expect(validateEventTypeAllowlist(["campaign_completed", "campaign_completed"]).ok).toBe(false);
  });

  it("C3: MVP catalog passes", () => {
    const r = validateEventTypeAllowlist(["onboarding_completed", "campaign_completed"]);
    expect(r).toEqual({ ok: true, types: ["onboarding_completed", "campaign_completed"] });
  });

  it("F8: missing checker fails closed", () => {
    expect(validateChecker("internal_state", null)).toMatch(/no reliable checker/);
    expect(validateChecker("internal_state", undefined)).toMatch(/no reliable checker/);
  });

  it("F8: unregistered checker is refused", () => {
    expect(validateChecker("internal_state", "internal_state.evil_custom")).toMatch(/not in MVP registry/);
  });

  it("F8: checker/type mismatch is refused", () => {
    expect(validateChecker("internal_state", "backend_check.achievement_owned")).toMatch(/does not match/);
  });

  it("F8: registered checker passes", () => {
    expect(validateChecker("internal_state", "internal_state.campaign_verified")).toBeNull();
  });
});

describe("F3 grant envelope (second-person OR justification)", () => {
  it("non-raises need no envelope", () => {
    expect(checkGrantEnvelope({ isRaise: false, actorAdminId: ADMIN })).toEqual({ ok: true });
  });

  it("raises without envelope are refused", () => {
    const r = checkGrantEnvelope({ isRaise: true, actorAdminId: ADMIN });
    expect(r.ok).toBe(false);
  });

  it("raises with justification pass", () => {
    expect(checkGrantEnvelope({ isRaise: true, actorAdminId: ADMIN, reason: "partner launch, verified contract" })).toEqual({ ok: true });
  });

  it("raises with short justification are refused", () => {
    expect(checkGrantEnvelope({ isRaise: true, actorAdminId: ADMIN, reason: "ok" }).ok).toBe(false);
  });

  it("self-confirm is not second-person", () => {
    const r = checkGrantEnvelope({ isRaise: true, actorAdminId: ADMIN, confirmedBy: ADMIN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different admin/);
  });

  it("different-admin confirm passes", () => {
    expect(checkGrantEnvelope({ isRaise: true, actorAdminId: ADMIN, confirmedBy: "boss@pid" })).toEqual({ ok: true });
  });
});

describe("ExperienceAdminService.setXpPermission (C3 atomic + F3)", () => {
  it("C3: unknown event type -> 400 and nothing is persisted", async () => {
    const update = jest.fn();
    const { svc } = serviceWith({ pidApp: { findUnique: jest.fn(async () => APP_ROW), update } });
    await expect(svc.setXpPermission(ADMIN, APP_ID, { xpEnabled: true, approvedEventTypes: ["mint_xp"] })).rejects.toThrow(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("F3: xpEnabled grant without envelope -> 400", async () => {
    const update = jest.fn();
    const { svc } = serviceWith({ pidApp: { findUnique: jest.fn(async () => APP_ROW), update } });
    await expect(
      svc.setXpPermission(ADMIN, APP_ID, { xpEnabled: true, approvedEventTypes: ["campaign_completed"] }),
    ).rejects.toThrow(/second-person|justification/);
    expect(update).not.toHaveBeenCalled();
  });

  it("grant with justification persists + audits before/after", async () => {
    const update = jest.fn(async ({ data }: { data: unknown }) => ({ ...APP_ROW, ...(data as object) }));
    const { svc, security } = serviceWith({ pidApp: { findUnique: jest.fn(async () => APP_ROW), update } });
    const r = await svc.setXpPermission(ADMIN, APP_ID, {
      xpEnabled: true,
      approvedEventTypes: ["campaign_completed"],
      reason: "launch partner, contract signed",
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(r.selfGrantAlert).toBe(false);
    expect(security.log).toHaveBeenCalledWith(
      ADMIN,
      "admin.xp.permission.granted",
      expect.objectContaining({
        before: { xpEnabled: false, approvedEventTypes: [] },
        after: { xpEnabled: true, approvedEventTypes: ["campaign_completed"] },
      }),
    );
  });

  it("F3: self-grant (owner == actor) fires an alert", async () => {
    const update = jest.fn(async ({ data }: { data: unknown }) => ({ ...APP_ROW, ...(data as object) }));
    const suspicious = jest.fn(async () => ({}));
    const { svc } = serviceWith({
      pidApp: { findUnique: jest.fn(async () => ({ ...APP_ROW, ownerPid: ADMIN })), update },
      xpSuspiciousActivity: { create: suspicious },
    });
    const r = await svc.setXpPermission(ADMIN, APP_ID, {
      xpEnabled: true,
      approvedEventTypes: ["campaign_completed"],
      reason: "my own app launch",
    });
    expect(r.selfGrantAlert).toBe(true);
    expect(suspicious).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: "xp.self_grant", appId: APP_ID }) }),
    );
  });

  it("confirmedBy must be an active admin", async () => {
    const { svc } = serviceWith({
      pidApp: { findUnique: jest.fn(async () => APP_ROW), update: jest.fn() },
      identity: { findUnique: jest.fn(async () => ({ role: "user", status: "active" })) },
    });
    await expect(
      svc.setXpPermission(ADMIN, APP_ID, {
        xpEnabled: true,
        approvedEventTypes: ["campaign_completed"],
        confirmedBy: "rando@pid",
      }),
    ).rejects.toThrow(/active admin/);
  });
});

describe("ExperienceAdminService.updateTask (F8 activation refusal)", () => {
  const DRAFT = {
    id: "task-1",
    status: "draft",
    verificationType: "internal_state",
    verificationChecker: null,
    availableFrom: null,
    availableUntil: null,
  };

  it("F8: checker-less activation -> 400 via direct service call", async () => {
    const update = jest.fn();
    const { svc } = serviceWith({ xpTask: { findUnique: jest.fn(async () => DRAFT), update } });
    await expect(svc.updateTask(ADMIN, "task-1", { status: "active" })).rejects.toThrow(/no reliable checker/);
    expect(update).not.toHaveBeenCalled();
  });

  it("activation with a registered checker succeeds", async () => {
    const update = jest.fn(async ({ data }: { data: object }) => ({ ...DRAFT, ...data }));
    const { svc } = serviceWith({ xpTask: { findUnique: jest.fn(async () => DRAFT), update } });
    const r = await svc.updateTask(ADMIN, "task-1", {
      status: "active",
      verificationChecker: "internal_state.campaign_verified",
    });
    expect((r as { status: string }).status).toBe("active");
  });

  it("archived tasks are immutable", async () => {
    const { svc } = serviceWith({ xpTask: { findUnique: jest.fn(async () => ({ ...DRAFT, status: "archived" })), update: jest.fn() } });
    await expect(svc.updateTask(ADMIN, "task-1", { name: "x" })).rejects.toThrow(/immutable/);
  });

  it("availability window is validated (from < until)", async () => {
    const { svc } = serviceWith({ xpTask: { findUnique: jest.fn(async () => DRAFT), update: jest.fn() } });
    await expect(
      svc.updateTask(ADMIN, "task-1", { availableFrom: "2026-12-01", availableUntil: "2026-01-01" } as never),
    ).rejects.toThrow(/before/);
  });
});

describe("ExperienceAdminService quotas + policy gates", () => {
  it("quota raise without envelope -> 400", async () => {
    const { svc } = serviceWith({
      pidApp: { findUnique: jest.fn(async () => APP_ROW) },
      xpQuota: { findUnique: jest.fn(async () => ({ appId: APP_ID, dailyCap: 100, weeklyCap: null, monthlyCap: null, suspended: false, suspendReason: null })), upsert: jest.fn() },
    });
    await expect(svc.upsertQuota(ADMIN, APP_ID, { dailyCap: 1000 })).rejects.toThrow(/second-person|justification/);
  });

  it("suspend without reason -> 400", async () => {
    const { svc } = serviceWith({
      pidApp: { findUnique: jest.fn(async () => APP_ROW) },
      xpQuota: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    });
    await expect(svc.upsertQuota(ADMIN, APP_ID, { suspended: true })).rejects.toThrow(/suspend/);
  });

  it("policy activation without envelope -> 400", async () => {
    const { svc } = serviceWith({});
    await expect(svc.activatePolicy(ADMIN, "policy-id", {})).rejects.toThrow(/second-person|justification/);
  });

  it("policy activation without materialized thresholds -> 400", async () => {
    const { svc } = serviceWith({
      identity: { findUnique: jest.fn(async () => ({ role: "admin", status: "active" })) },
      xpPolicyVersion: { findUnique: jest.fn(async () => ({ id: "p9", version: 9, activatedAt: null, supersededAt: null })) },
      xpLevelThreshold: { count: jest.fn(async () => 0) },
    });
    await expect(svc.activatePolicy(ADMIN, "p9", { reason: "rollout approved by product review" })).rejects.toThrow(
      /materialize first/,
    );
  });
});

describe("ExperienceAdminService adjustments/reversals delegation (F4 actor)", () => {
  it("adjust passes the admin actor through (reason enforced in LedgerService)", async () => {
    const { svc, ledger, security } = serviceWith({});
    ledger.adjustXp.mockResolvedValue({ pid: "tester@pid", awardedXp: 10, totalXp: 10n, level: 1, leveledUp: false, duplicate: false });
    await svc.adjust(ADMIN, { pid: "tester@pid", deltaXp: 10, reason: "support credit" });
    expect(ledger.adjustXp).toHaveBeenCalledWith({ pid: "tester@pid", deltaXp: 10, reason: "support credit", actorAdminId: ADMIN });
    expect(security.log).toHaveBeenCalledWith(ADMIN, "admin.xp.adjusted", expect.objectContaining({ pid: "tester@pid" }));
  });

  it("reverse validates the original entry pid-link", async () => {
    const { svc } = serviceWith({
      xpLedgerEntry: { findUnique: jest.fn(async () => ({ id: "e1", pid: "other@pid" })) },
    });
    await expect(svc.reverse(ADMIN, { pid: "tester@pid", amount: 5, reason: "fraud clawback", originalEntryId: "e1" })).rejects.toThrow(
      /different pid/,
    );
  });
});

describe("ExperienceAdminController guards (F3/F4 never app-token-enforceable)", () => {
  it("class carries JwtAuthGuard + AdminGuard (AdminGuard rejects app tokens)", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ExperienceAdminController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(AdminGuard);
  });
});

describe("append-only ledger by mechanism (F4)", () => {
  it("no update/delete/upsert path exists on xpLedgerEntry in experience/ (non-spec sources)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
    expect(files).toContain("ledger.service.ts");
    const hits: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const line of src.split("\n")) {
        if (/xpLedgerEntry\.(update|delete|deleteMany|upsert)/.test(line)) hits.push(`${f}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no bulk-adjust endpoint exists on the admin controller", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "experience-admin.controller.ts"), "utf8");
    // Route paths (not comments): no bulk-adjust route may exist without
    // second-person confirm (F4) — none ships here at all.
    expect(src).not.toMatch(/@(?:Post|Put|Patch|Delete)\([^)]*bulk/i);
  });
});

describe("LedgerService.adjustXp / reverseXp (F4 server enforcement + W1)", () => {
  const ACTIVE = {
    policy: { id: "policy-v1" },
    formula: DEFAULT_FORMULA,
    thresholds: buildThresholds(100, DEFAULT_FORMULA),
  };
  const levelsMock = { getActivePolicy: jest.fn(async () => ACTIVE) } as never;

  function fakePrisma() {
    const tables = {
      states: new Map<string, { pid: string; totalXp: bigint; level: number; policyVersionId: string }>(),
      entries: [] as Array<{ id: string; pid: string; deltaXp: bigint; balanceAfter: bigint; levelAfter: number; kind: string; reason: string | null; actorAdminId: string | null }>,
    };
    const tx = {
      $queryRaw: jest.fn(async () => (tables.states.size > 0 ? [{ pid: "tester@pid" }] : [])),
      userXpState: {
        findUniqueOrThrow: jest.fn(async ({ where }: { where: { pid: string } }) => {
          const row = tables.states.get(where.pid);
          if (!row) throw new Error("not found");
          return row;
        }),
        create: jest.fn(async ({ data }: { data: { pid: string; totalXp: bigint; level: number; policyVersionId: string } }) => {
          const row = { ...data };
          tables.states.set(data.pid, row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: { where: { pid: string }; data: Partial<{ totalXp: bigint; level: number }> }) => {
          const row = tables.states.get(where.pid);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        }),
      },
      xpLedgerEntry: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `e${tables.entries.length + 1}`,
            pid: data.pid,
            deltaXp: data.deltaXp,
            balanceAfter: data.balanceAfter,
            levelAfter: data.levelAfter,
            kind: data.kind,
            reason: (data.reason as string | null) ?? null,
            actorAdminId: (data.actorAdminId as string | null) ?? null,
          } as (typeof tables.entries)[number];
          tables.entries.push(row);
          return row;
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)) } as never;
    const service = new LedgerService(prisma, levelsMock);
    return { service, tables, tx };
  }

  it("F4: reason-less adjustment -> 400", async () => {
    const { service } = fakePrisma();
    await expect(service.adjustXp({ pid: "tester@pid", deltaXp: 10, reason: "  ", actorAdminId: ADMIN })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.adjustXp({ pid: "tester@pid", deltaXp: 10, reason: "ok", actorAdminId: " " })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("F4: adjustment ledger row carries reason + actor", async () => {
    const { service, tables } = fakePrisma();
    await service.adjustXp({ pid: "tester@pid", deltaXp: 50, reason: "support credit", actorAdminId: ADMIN });
    expect(tables.entries).toHaveLength(1);
    expect(tables.entries[0]).toMatchObject({ kind: "manual_adjustment", deltaXp: 50n, reason: "support credit", actorAdminId: ADMIN });
    expect(tables.states.get("tester@pid")?.totalXp).toBe(50n);
  });

  it("F4: reason-less reversal -> 400", async () => {
    const { service } = fakePrisma();
    await expect(service.reverseXp({ pid: "tester@pid", amount: 5, reason: "", actorAdminId: ADMIN })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("W1: reversal is a NEW negative entry; balances reconcile", async () => {
    const { service, tables } = fakePrisma();
    await service.adjustXp({ pid: "tester@pid", deltaXp: 100, reason: "grant", actorAdminId: ADMIN });
    const r = await service.reverseXp({ pid: "tester@pid", amount: 30, reason: "fraud clawback", actorAdminId: ADMIN });
    expect(tables.entries).toHaveLength(2);
    expect(tables.entries[1]).toMatchObject({ kind: "reversal", deltaXp: -30n, balanceAfter: 70n, actorAdminId: ADMIN });
    expect(r.totalXp).toBe(70n);
    const sum = tables.entries.reduce((a, e) => a + e.deltaXp, 0n);
    expect(sum).toBe(tables.states.get("tester@pid")?.totalXp);
  });

  it("reversal beyond balance -> 400 (no negative XP)", async () => {
    const { service } = fakePrisma();
    await service.adjustXp({ pid: "tester@pid", deltaXp: 10, reason: "grant", actorAdminId: ADMIN });
    await expect(service.reverseXp({ pid: "tester@pid", amount: 11, reason: "too much", actorAdminId: ADMIN })).rejects.toThrow(
      /exceeds balance/,
    );
  });
});
