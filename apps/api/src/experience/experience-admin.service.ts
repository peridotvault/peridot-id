import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import {
  MVP_EVENT_TYPES,
  TASK_KEY_FORMAT,
  TASK_RECURRING,
  TASK_STATUSES,
  validateChecker,
  validateEventTypeAllowlist,
} from "./catalog";
import {
  ActivatePolicyDto,
  CreatePolicyDto,
  CreateTaskDto,
  MaterializePolicyDto,
  SECOND_PERSON_MIN_REASON,
  SetXpPermissionDto,
  SuspendAppDto,
  UpsertQuotaDto,
} from "./experience-admin.dto";
import { LedgerService } from "./ledger.service";
import { LevelsService } from "./levels.service";
import { buildThresholds, DEFAULT_FORMULA, levelFromXp, XpFormula } from "./xp-curve";

export const XP_PERMISSION_EVENT_CATALOG = [...MVP_EVENT_TYPES];

/**
 * F3 grant envelope verdict (pure — unit tested without a DB).
 *
 * Raises/grants require second-person confirm (a DIFFERENT admin) OR a
 * mandatory justification (>= 10 chars). Non-raises (disables, cap lowers,
 * narrows) need no envelope but are still audited by the caller.
 */
export function checkGrantEnvelope(input: {
  isRaise: boolean;
  actorAdminId: string;
  confirmedBy?: string;
  reason?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!input.isRaise) return { ok: true };
  const confirmedBy = (input.confirmedBy ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (confirmedBy) {
    if (confirmedBy.toLowerCase() === input.actorAdminId.toLowerCase()) {
      return { ok: false, error: "confirmedBy must be a different admin (self-confirm is not second-person)" };
    }
    return { ok: true };
  }
  if (reason.length >= SECOND_PERSON_MIN_REASON) return { ok: true };
  return {
    ok: false,
    error: `permission grants require second-person confirm (confirmedBy) or justification (reason >= ${SECOND_PERSON_MIN_REASON} chars)`,
  };
}

function toFormula(dto: CreatePolicyDto): XpFormula {
  const base = dto.base ?? DEFAULT_FORMULA.base;
  const exponent = dto.exponent ?? DEFAULT_FORMULA.exponent;
  if (!Number.isInteger(base) || base < 1 || base > 100000) {
    throw new BadRequestException("base must be an integer 1..100000");
  }
  if (typeof exponent !== "number" || !Number.isFinite(exponent) || exponent < 0.5 || exponent > 3) {
    throw new BadRequestException("exponent must be a number 0.5..3");
  }
  return { base, exponent, rounding: "floor" };
}

function parseOverrides(raw: MaterializePolicyDto["overrides"], maxLevel: number): Map<number, number> {
  const map = new Map<number, number>();
  if (!raw) return map;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("overrides must be an object");
  for (const [k, v] of Object.entries(raw)) {
    const level = Number(k);
    if (!Number.isInteger(level) || level < 1 || level > maxLevel) {
      throw new BadRequestException(`override level out of range 1..${maxLevel}: ${k}`);
    }
    if (!Number.isInteger(v) || v < 0 || v > 1_000_000_000_000) {
      throw new BadRequestException(`override xp must be an integer 0..1e12 (level ${k})`);
    }
    map.set(level, v);
  }
  return map;
}

function validateTaskSemantics(input: {
  recurring?: string;
  lifetimeLimit?: number | null;
  dailyLimit?: number | null;
  weeklyLimit?: number | null;
  monthlyLimit?: number | null;
  availableFrom?: string | Date | null;
  availableUntil?: string | Date | null;
}): void {
  if (input.recurring !== undefined && !(TASK_RECURRING as readonly string[]).includes(input.recurring)) {
    throw new BadRequestException(`recurring must be one of ${(TASK_RECURRING as readonly string[]).join("|")}`);
  }
  if (input.availableFrom && input.availableUntil) {
    const from = new Date(input.availableFrom).getTime();
    const until = new Date(input.availableUntil).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(until)) throw new BadRequestException("invalid availability dates");
    if (from >= until) throw new BadRequestException("availableFrom must be before availableUntil");
  }
}

function sanitizeTaskKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (!TASK_KEY_FORMAT.test(k)) throw new BadRequestException("key must match ^[a-z][a-z0-9_]{2,63}$");
  return k;
}

const MAX_INT = 100000;

/**
 * ANT-89 M2 — admin experience API (dashboard-backed, Role.admin everywhere).
 *
 * - Policy versions: draft → materialize → impact-preview → activate (R4 flow
 *   up to activation; migration execution tooling stays M3-gated).
 * - Tasks CRUD + status lifecycle; activation REFUSED (400) without a
 *   registered reliable checker (Tobias F8, API-enforced).
 * - Event-type allowlist validated at write: format + MVP-catalog membership;
 *   unknown types → 400 with nothing persisted (Tobias C3).
 * - xpEnabled/quota grants: second-person confirm OR mandatory justification +
 *   immutable audit; self-grants fire an alert (Tobias F3). App tokens can
 *   never satisfy these routes (AdminGuard, controller-level).
 * - Manual adjustments + reversals delegate to LedgerService (F4:
 *   reason + actor required, 400 otherwise; reversals are NEW negative
 *   entries per waiver W1). No bulk-adjust endpoint ships here.
 * - Quotas CRUD + suspend/unsuspend + suspicious-activity review.
 */
@Injectable()
export class ExperienceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
    private readonly ledger: LedgerService,
    private readonly security: SecurityEventService,
  ) {}

  // -- policy versions ---------------------------------------------------

  async listPolicies() {
    const rows = await this.prisma.xpPolicyVersion.findMany({ orderBy: { version: "desc" } });
    const counts = await this.prisma.xpLevelThreshold.groupBy({
      by: ["policyVersionId"],
      _count: { level: true },
    });
    const byId = new Map(counts.map((c) => [c.policyVersionId, c._count.level]));
    return rows.map((p) => ({
      ...p,
      active: p.activatedAt !== null && p.supersededAt === null,
      thresholdCount: byId.get(p.id) ?? 0,
    }));
  }

  async createPolicyDraft(actorAdminId: string, dto: CreatePolicyDto) {
    const formula = toFormula(dto);
    const maxLevel = dto.maxLevel ?? DEFAULT_FORMULA_MAX_LEVEL();
    if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 10000) {
      throw new BadRequestException("maxLevel must be an integer 1..10000");
    }
    const max = await this.prisma.xpPolicyVersion.aggregate({ _max: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    try {
      const row = await this.prisma.xpPolicyVersion.create({
        data: { version, formula: formula as unknown as Prisma.InputJsonValue, maxLevel, createdBy: actorAdminId },
      });
      await this.security.log(actorAdminId, "admin.xp.policy.drafted", { policyId: row.id, version, formula, maxLevel });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("policy version collision — retry");
      }
      throw e;
    }
  }

  async materializePolicy(actorAdminId: string, id: string, dto: MaterializePolicyDto) {
    const policy = await this.prisma.xpPolicyVersion.findUnique({ where: { id } });
    if (!policy) throw new NotFoundException("policy not found");
    if (policy.activatedAt) throw new BadRequestException("active/superseded policies are immutable — draft a new version");
    const formula = policy.formula as unknown as XpFormula;
    const maxLevel = policy.maxLevel ?? DEFAULT_FORMULA_MAX_LEVEL();
    const overrides = parseOverrides(dto.overrides, maxLevel);
    let rows;
    try {
      rows = buildThresholds(maxLevel, formula, overrides);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.prisma.$transaction([
      this.prisma.xpLevelThreshold.deleteMany({ where: { policyVersionId: id } }),
      this.prisma.xpLevelThreshold.createMany({
        data: rows.map((r) => ({ policyVersionId: id, level: r.level, cumulativeXp: BigInt(r.cumulativeXp) })),
      }),
    ]);
    await this.security.log(actorAdminId, "admin.xp.policy.materialized", {
      policyId: id,
      version: policy.version,
      thresholdCount: rows.length,
      overrideCount: overrides.size,
    });
    return { policyId: id, version: policy.version, thresholdCount: rows.length };
  }

  /**
   * R4 impact preview (read-only): threshold diff vs the active policy plus
   * the user-level impact if this draft were activated. Bounded: at most
   * 20k user rows are evaluated; `truncated` flags wider fleets (M3 backfill
   * tooling pages the full migration under release gates).
   */
  async previewPolicy(id: string) {
    const draft = await this.prisma.xpPolicyVersion.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException("policy not found");
    const draftRows = await this.prisma.xpLevelThreshold.findMany({
      where: { policyVersionId: id },
      orderBy: { level: "asc" },
    });
    if (draftRows.length === 0) throw new BadRequestException("policy has no materialized thresholds — materialize first");
    const draftThresholds = draftRows.map((r) => ({ level: r.level, cumulativeXp: Number(r.cumulativeXp) }));
    const active = await this.levels.getActivePolicy().catch(() => null);
    const activeByLevel = new Map((active?.thresholds ?? []).map((t) => [t.level, t.cumulativeXp]));
    const thresholdDiff = draftThresholds.map((t) => ({
      level: t.level,
      draftXp: t.cumulativeXp,
      activeXp: activeByLevel.get(t.level) ?? null,
      delta: activeByLevel.has(t.level) ? t.cumulativeXp - (activeByLevel.get(t.level) as number) : null,
    }));
    const CAP = 20000;
    const states = await this.prisma.userXpState.findMany({
      select: { totalXp: true },
      take: CAP + 1,
    });
    const truncated = states.length > CAP;
    let leveledUp = 0;
    let leveledDown = 0;
    let unchanged = 0;
    for (const s of states.slice(0, CAP)) {
      const nowLevel = active ? levelFromXp(s.totalXp, active.thresholds) : 1;
      const nextLevel = levelFromXp(s.totalXp, draftThresholds);
      if (nextLevel > nowLevel) leveledUp++;
      else if (nextLevel < nowLevel) leveledDown++;
      else unchanged++;
    }
    return {
      policyId: id,
      version: draft.version,
      activeVersion: active?.policy.version ?? null,
      thresholdCount: draftThresholds.length,
      thresholdDiff,
      userImpact: { evaluated: Math.min(states.length, CAP), truncated, leveledUp, leveledDown, unchanged },
    };
  }

  /**
   * R4 activation flip (single transaction). Requires the draft to be
   * materialized and an F3-grade envelope (second-person OR justification).
   * Migration execution (backfill) stays M3-gated — activation only flips the
   * pointer; per-user levels recompute lazily (levels.service re-level hook)
   * and on the next award.
   */
  async activatePolicy(actorAdminId: string, id: string, dto: ActivatePolicyDto) {
    const verdict = checkGrantEnvelope({ isRaise: true, actorAdminId, confirmedBy: dto.confirmedBy, reason: dto.reason });
    if (!verdict.ok) throw new BadRequestException((verdict as { error: string }).error);
    const confirmedBy = (dto.confirmedBy ?? "").trim() || null;
    if (confirmedBy) await this.requireActiveAdmin(confirmedBy);
    const draft = await this.prisma.xpPolicyVersion.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException("policy not found");
    if (draft.activatedAt && !draft.supersededAt) throw new BadRequestException("policy is already active");
    if (draft.supersededAt) throw new BadRequestException("superseded policies cannot be reactivated — draft a new version");
    const thresholdCount = await this.prisma.xpLevelThreshold.count({ where: { policyVersionId: id } });
    if (thresholdCount === 0) throw new BadRequestException("policy has no materialized thresholds — materialize first");
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.xpPolicyVersion.findFirst({
        where: { activatedAt: { not: null }, supersededAt: null },
      });
      if (current && current.id !== id) {
        await tx.xpPolicyVersion.update({ where: { id: current.id }, data: { supersededAt: now } });
      }
      return tx.xpPolicyVersion.update({
        where: { id },
        data: { activatedAt: now, supersededAt: null },
      });
    });
    await this.security.log(actorAdminId, "admin.xp.policy.activated", {
      policyId: id,
      version: draft.version,
      confirmedBy,
      reason: (dto.reason ?? "").trim() || null,
    });
    return result;
  }

  // -- tasks -------------------------------------------------------------

  async createTask(actorAdminId: string, dto: CreateTaskDto) {
    const key = sanitizeTaskKey(dto.key);
    validateTaskSemantics(dto);
    if (dto.scopeAppId) await this.requireApp(dto.scopeAppId);
    if (dto.verificationType !== undefined && !(["internal_state", "backend_check"] as string[]).includes(dto.verificationType)) {
      throw new BadRequestException("verificationType must be internal_state|backend_check");
    }
    try {
      const task = await this.prisma.xpTask.create({
        data: {
          key,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          xpReward: dto.xpReward,
          recurring: dto.recurring ?? "once",
          lifetimeLimit: dto.lifetimeLimit ?? null,
          dailyLimit: dto.dailyLimit ?? null,
          weeklyLimit: dto.weeklyLimit ?? null,
          monthlyLimit: dto.monthlyLimit ?? null,
          cooldownSecs: dto.cooldownSecs ?? null,
          availableFrom: dto.availableFrom ? new Date(dto.availableFrom) : null,
          availableUntil: dto.availableUntil ? new Date(dto.availableUntil) : null,
          verificationType: dto.verificationType ?? "internal_state",
          verificationChecker: dto.verificationChecker?.trim() || null,
          scopeAppId: dto.scopeAppId ?? null,
          createdBy: actorAdminId,
        },
      });
      await this.security.log(actorAdminId, "admin.xp.task.created", { taskId: task.id, key });
      return task;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("task key already exists");
      }
      throw e;
    }
  }

  async listTasks(query: { status?: string; limit?: number; offset?: number }) {
    if (query.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(query.status)) {
      throw new BadRequestException(`status must be one of ${(TASK_STATUSES as readonly string[]).join("|")}`);
    }
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Math.floor(query.offset ?? 0) || 0, 0);
    const [rows, total] = await Promise.all([
      this.prisma.xpTask.findMany({
        where: query.status ? { status: query.status } : undefined,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset || undefined,
      }),
      this.prisma.xpTask.count({ where: query.status ? { status: query.status } : undefined }),
    ]);
    return { rows, total, limit, offset };
  }

  async getTask(id: string) {
    const task = await this.prisma.xpTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException("task not found");
    return task;
  }

  async updateTask(actorAdminId: string, id: string, dto: Record<string, unknown>) {
    const task = await this.prisma.xpTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException("task not found");
    if (task.status === "archived") throw new BadRequestException("archived tasks are immutable");
    const patch = dto as Partial<{
      name: string;
      description: string | null;
      xpReward: number;
      recurring: string;
      lifetimeLimit: number | null;
      dailyLimit: number | null;
      weeklyLimit: number | null;
      monthlyLimit: number | null;
      cooldownSecs: number | null;
      availableFrom: string | null;
      availableUntil: string | null;
      verificationType: string;
      verificationChecker: string | null;
      scopeAppId: string | null;
      status: string;
    }>;
    if (patch.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(patch.status)) {
      throw new BadRequestException(`status must be one of ${(TASK_STATUSES as readonly string[]).join("|")}`);
    }
    if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 120)) {
      throw new BadRequestException("name must be 1-120 chars");
    }
    if (patch.xpReward !== undefined && (!Number.isInteger(patch.xpReward) || patch.xpReward < 1 || patch.xpReward > MAX_INT)) {
      throw new BadRequestException("xpReward must be an integer 1..100000");
    }
    for (const f of ["lifetimeLimit", "dailyLimit", "weeklyLimit", "monthlyLimit"] as const) {
      const v = patch[f];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1)) {
        throw new BadRequestException(`${f} must be a positive integer or null`);
      }
    }
    if (patch.cooldownSecs !== undefined && patch.cooldownSecs !== null) {
      if (!Number.isInteger(patch.cooldownSecs) || patch.cooldownSecs < 0 || patch.cooldownSecs > 31536000) {
        throw new BadRequestException("cooldownSecs must be an integer 0..31536000 or null");
      }
    }
    if (patch.verificationType !== undefined && !["internal_state", "backend_check"].includes(patch.verificationType)) {
      throw new BadRequestException("verificationType must be internal_state|backend_check");
    }
    validateTaskSemantics({
      recurring: patch.recurring,
      availableFrom: patch.availableFrom ?? task.availableFrom,
      availableUntil: patch.availableUntil ?? task.availableUntil,
    });
    if (patch.scopeAppId !== undefined && patch.scopeAppId !== null) await this.requireApp(patch.scopeAppId);
    // F8: activation (and staying active under a checker change) requires a
    // registered reliable checker — enforced here, never UI-only.
    const nextStatus = patch.status ?? task.status;
    const nextType = patch.verificationType ?? task.verificationType;
    const nextChecker = patch.verificationChecker !== undefined ? patch.verificationChecker : task.verificationChecker;
    if (nextStatus === "active") {
      const err = validateChecker(nextType, nextChecker);
      if (err) throw new BadRequestException(err);
    }
    const data: Record<string, unknown> = {};
    for (const f of [
      "name",
      "description",
      "xpReward",
      "recurring",
      "lifetimeLimit",
      "dailyLimit",
      "weeklyLimit",
      "monthlyLimit",
      "cooldownSecs",
      "verificationType",
      "verificationChecker",
      "scopeAppId",
      "status",
    ] as const) {
      if (patch[f] !== undefined) data[f] = patch[f];
    }
    if (patch.availableFrom !== undefined) data.availableFrom = patch.availableFrom ? new Date(patch.availableFrom) : null;
    if (patch.availableUntil !== undefined) data.availableUntil = patch.availableUntil ? new Date(patch.availableUntil) : null;
    if (typeof data.name === "string") data.name = data.name.trim();
    const updated = await this.prisma.xpTask.update({ where: { id }, data: data as never });
    await this.security.log(actorAdminId, "admin.xp.task.updated", { taskId: id, patch: Object.keys(data) });
    return updated;
  }

  // -- verification / XP permission (C3 + F3) ------------------------------

  async setXpPermission(actorAdminId: string, appId: string, dto: SetXpPermissionDto) {
    const app = await this.prisma.pidApp.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    // C3: strict format + MVP-catalog membership; unknown → 400 BEFORE any write.
    const checked = validateEventTypeAllowlist(dto.approvedEventTypes);
    if (!checked.ok) {
      throw new BadRequestException(`approvedEventTypes rejected: ${checked.errors.join("; ")}`);
    }
    const prevTypes = new Set(app.approvedEventTypes ?? []);
    const nextTypes = checked.types;
    const widened = nextTypes.some((t) => !prevTypes.has(t));
    const granting = dto.xpEnabled && !app.xpEnabled;
    const isRaise = granting || (dto.xpEnabled && widened);
    // F3: grants need second-person confirm or mandatory justification.
    const verdict = checkGrantEnvelope({ isRaise, actorAdminId, confirmedBy: dto.confirmedBy, reason: dto.reason });
    if (!verdict.ok) throw new BadRequestException((verdict as { error: string }).error);
    const confirmedBy = (dto.confirmedBy ?? "").trim() || null;
    if (confirmedBy) await this.requireActiveAdmin(confirmedBy);
    const before = { xpEnabled: app.xpEnabled, approvedEventTypes: app.approvedEventTypes };
    const after = { xpEnabled: dto.xpEnabled, approvedEventTypes: nextTypes };
    // Single write — on validation failure above nothing was persisted (C3 atomicity).
    const updated = await this.prisma.pidApp.update({ where: { id: appId }, data: after });
    await this.security.log(actorAdminId, dto.xpEnabled ? "admin.xp.permission.granted" : "admin.xp.permission.revoked", {
      appId,
      clientId: app.clientId,
      ownerPid: app.ownerPid,
      before,
      after,
      confirmedBy,
      reason: (dto.reason ?? "").trim() || null,
    });
    // F3 self-grant alert: the acting admin owns this app.
    let selfGrantAlert = false;
    if (isRaise && app.ownerPid.toLowerCase() === actorAdminId.toLowerCase()) {
      selfGrantAlert = true;
      await this.prisma.xpSuspiciousActivity.create({
        data: {
          pid: actorAdminId,
          appId,
          signal: "xp.self_grant",
          detail: { actorAdminId, appId, clientId: app.clientId, before, after } as Prisma.InputJsonValue,
        },
      });
      await this.security.log(actorAdminId, "admin.xp.permission.self_grant_alert", { appId, clientId: app.clientId });
    }
    const { webhookSecret: _s, clientSecretHash: _h, prevClientSecretHash: _p, ...safe } = updated as typeof updated & {
      prevClientSecretHash?: unknown;
    };
    return { app: safe, selfGrantAlert };
  }

  // -- quotas + suspend (F3 on raises) -------------------------------------

  async upsertQuota(actorAdminId: string, appId: string, dto: UpsertQuotaDto) {
    const app = await this.prisma.pidApp.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    for (const f of ["dailyCap", "weeklyCap", "monthlyCap"] as const) {
      const v = dto[f];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > 100000000)) {
        throw new BadRequestException(`${f} must be a positive integer or null`);
      }
    }
    const prev = await this.prisma.xpQuota.findUnique({ where: { appId } });
    const next = {
      dailyCap: dto.dailyCap !== undefined ? dto.dailyCap : (prev?.dailyCap ?? null),
      weeklyCap: dto.weeklyCap !== undefined ? dto.weeklyCap : (prev?.weeklyCap ?? null),
      monthlyCap: dto.monthlyCap !== undefined ? dto.monthlyCap : (prev?.monthlyCap ?? null),
      suspended: dto.suspended ?? prev?.suspended ?? false,
      suspendReason: dto.suspendReason !== undefined ? dto.suspendReason : (prev?.suspendReason ?? null),
    };
    const raised =
      (next.dailyCap != null && (prev?.dailyCap == null || next.dailyCap > (prev.dailyCap as number))) ||
      (next.weeklyCap != null && (prev?.weeklyCap == null || next.weeklyCap > (prev.weeklyCap as number))) ||
      (next.monthlyCap != null && (prev?.monthlyCap == null || next.monthlyCap > (prev.monthlyCap as number))) ||
      Boolean(prev?.suspended && !next.suspended);
    if (next.suspended && !((dto.suspendReason ?? next.suspendReason ?? "").trim() || (dto.reason ?? "").trim())) {
      throw new BadRequestException("suspending requires suspendReason or reason");
    }
    const verdict = checkGrantEnvelope({ isRaise: raised, actorAdminId, confirmedBy: dto.confirmedBy, reason: dto.reason });
    if (!verdict.ok) throw new BadRequestException((verdict as { error: string }).error);
    const confirmedBy = (dto.confirmedBy ?? "").trim() || null;
    if (confirmedBy) await this.requireActiveAdmin(confirmedBy);
    const row = await this.prisma.xpQuota.upsert({
      where: { appId },
      update: next,
      create: { appId, ...next },
    });
    await this.security.log(actorAdminId, "admin.xp.quota.set", {
      appId,
      clientId: app.clientId,
      before: prev ?? null,
      after: row,
      confirmedBy,
      reason: (dto.reason ?? "").trim() || null,
    });
    let selfGrantAlert = false;
    if (raised && app.ownerPid.toLowerCase() === actorAdminId.toLowerCase()) {
      selfGrantAlert = true;
      await this.prisma.xpSuspiciousActivity.create({
        data: {
          pid: actorAdminId,
          appId,
          signal: "xp.self_grant",
          detail: { actorAdminId, appId, kind: "quota_raise", before: prev ?? null, after: row } as Prisma.InputJsonValue,
        },
      });
    }
    return { quota: row, selfGrantAlert };
  }

  async upsertOrgQuota(actorAdminId: string, ownerPid: string, dto: UpsertQuotaDto) {
    const owner = await this.prisma.identity.findUnique({ where: { pid: ownerPid.toLowerCase() } });
    if (!owner) throw new NotFoundException("owner not found");
    for (const f of ["dailyCap", "weeklyCap", "monthlyCap"] as const) {
      const v = dto[f];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > 100000000)) {
        throw new BadRequestException(`${f} must be a positive integer or null`);
      }
    }
    const prev = await this.prisma.xpOrgQuota.findUnique({ where: { ownerPid: owner.pid } });
    const next = {
      dailyCap: dto.dailyCap !== undefined ? dto.dailyCap : (prev?.dailyCap ?? null),
      weeklyCap: dto.weeklyCap !== undefined ? dto.weeklyCap : (prev?.weeklyCap ?? null),
      monthlyCap: dto.monthlyCap !== undefined ? dto.monthlyCap : (prev?.monthlyCap ?? null),
    };
    const raised =
      (next.dailyCap != null && (prev?.dailyCap == null || next.dailyCap > prev.dailyCap)) ||
      (next.weeklyCap != null && (prev?.weeklyCap == null || next.weeklyCap > prev.weeklyCap)) ||
      (next.monthlyCap != null && (prev?.monthlyCap == null || next.monthlyCap > prev.monthlyCap));
    const verdict = checkGrantEnvelope({ isRaise: raised, actorAdminId, confirmedBy: dto.confirmedBy, reason: dto.reason });
    if (!verdict.ok) throw new BadRequestException((verdict as { error: string }).error);
    const confirmedBy = (dto.confirmedBy ?? "").trim() || null;
    if (confirmedBy) await this.requireActiveAdmin(confirmedBy);
    const row = await this.prisma.xpOrgQuota.upsert({
      where: { ownerPid: owner.pid },
      update: next,
      create: { ownerPid: owner.pid, ...next },
    });
    await this.security.log(actorAdminId, "admin.xp.org_quota.set", {
      ownerPid: owner.pid,
      before: prev ?? null,
      after: row,
      confirmedBy,
      reason: (dto.reason ?? "").trim() || null,
    });
    return { quota: row };
  }

  async suspendApp(actorAdminId: string, appId: string, dto: SuspendAppDto) {
    return this.upsertQuota(actorAdminId, appId, {
      suspended: dto.suspended,
      suspendReason: dto.suspendReason ?? dto.reason ?? null,
      reason: dto.reason,
    });
  }

  // -- adjustments + reversals (F4, via LedgerService) ----------------------

  async adjust(actorAdminId: string, dto: { pid: string; deltaXp: number; reason: string }) {
    const result = await this.ledger.adjustXp({ pid: dto.pid, deltaXp: dto.deltaXp, reason: dto.reason, actorAdminId });
    await this.security.log(actorAdminId, "admin.xp.adjusted", {
      pid: result.pid,
      awardedXp: result.awardedXp,
      totalXp: result.totalXp.toString(),
      reason: dto.reason,
    });
    return { ...result, totalXp: result.totalXp.toString() };
  }

  async reverse(actorAdminId: string, dto: { pid: string; amount: number; reason: string; originalEntryId?: string }) {
    if (dto.originalEntryId) {
      const original = await this.prisma.xpLedgerEntry.findUnique({ where: { id: dto.originalEntryId } });
      if (!original) throw new NotFoundException("original ledger entry not found");
      if (original.pid.toLowerCase() !== dto.pid.trim().toLowerCase()) {
        throw new BadRequestException("original entry belongs to a different pid");
      }
    }
    const result = await this.ledger.reverseXp({
      pid: dto.pid,
      amount: dto.amount,
      reason: dto.reason,
      actorAdminId,
      originalEntryId: dto.originalEntryId,
    });
    await this.security.log(actorAdminId, "admin.xp.reversed", {
      pid: result.pid,
      reversedXp: -result.awardedXp,
      totalXp: result.totalXp.toString(),
      reason: dto.reason,
      originalEntryId: dto.originalEntryId ?? null,
    });
    return { ...result, totalXp: result.totalXp.toString() };
  }

  // -- reads: history, suspicious review, overview ---------------------------

  async ledgerHistory(query: { pid?: string; kind?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50) || 50, 1), 100);
    const offset = Math.max(Math.floor(query.offset ?? 0) || 0, 0);
    const where: Record<string, unknown> = {};
    if (query.pid) where.pid = query.pid.trim().toLowerCase();
    if (query.kind) {
      if (!["task_award", "manual_adjustment", "reversal"].includes(query.kind)) {
        throw new BadRequestException("kind must be task_award|manual_adjustment|reversal");
      }
      where.kind = query.kind;
    }
    const [rows, total] = await Promise.all([
      this.prisma.xpLedgerEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset || undefined }),
      this.prisma.xpLedgerEntry.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({ ...r, deltaXp: r.deltaXp.toString(), balanceAfter: r.balanceAfter.toString() })),
      total,
      limit,
      offset,
    };
  }

  async listSuspicious(query: { reviewed?: boolean; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50) || 50, 1), 100);
    const offset = Math.max(Math.floor(query.offset ?? 0) || 0, 0);
    const where: Record<string, unknown> = {};
    if (query.reviewed !== undefined) where.reviewed = query.reviewed;
    const [rows, total] = await Promise.all([
      this.prisma.xpSuspiciousActivity.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset || undefined,
      }),
      this.prisma.xpSuspiciousActivity.count({ where }),
    ]);
    return { rows, total, limit, offset };
  }

  async reviewSuspicious(actorAdminId: string, id: string, dto: { reviewed: boolean; note?: string }) {
    const row = await this.prisma.xpSuspiciousActivity.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("suspicious activity not found");
    const updated = await this.prisma.xpSuspiciousActivity.update({ where: { id }, data: { reviewed: dto.reviewed } });
    await this.security.log(actorAdminId, "admin.xp.suspicious.reviewed", {
      suspiciousId: id,
      reviewed: dto.reviewed,
      note: (dto.note ?? "").trim() || null,
    });
    return updated;
  }

  /** Dashboard overview aggregates (all bounded: single aggregates + capped takes). */
  async overview() {
    const [creditSum, statesCount, levelDist, recent, unreviewed] = await Promise.all([
      this.prisma.xpLedgerEntry.aggregate({ _sum: { deltaXp: true } }),
      this.prisma.userXpState.count(),
      this.prisma.userXpState.groupBy({ by: ["level"], _count: { level: true }, orderBy: { level: "asc" } }),
      this.prisma.xpLedgerEntry.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.xpSuspiciousActivity.count({ where: { reviewed: false } }),
    ]);
    return {
      totalXpDistributed: (creditSum._sum.deltaXp ?? 0n).toString(),
      totalUsers: statesCount,
      levelDistribution: levelDist.map((d) => ({ level: d.level, users: d._count.level })),
      recentActivity: recent.map((r) => ({ ...r, deltaXp: r.deltaXp.toString(), balanceAfter: r.balanceAfter.toString() })),
      unreviewedSuspicious: unreviewed,
    };
  }

  // -- helpers ---------------------------------------------------------------

  private async requireApp(appId: string) {
    const app = await this.prisma.pidApp.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("scope app not found");
    return app;
  }

  private async requireActiveAdmin(pid: string) {
    const identity = await this.prisma.identity.findUnique({ where: { pid: pid.toLowerCase() } });
    if (!identity || identity.status !== "active" || identity.role !== "admin") {
      throw new BadRequestException("confirmedBy must be an active admin");
    }
    return identity;
  }
}

function DEFAULT_FORMULA_MAX_LEVEL(): number {
  return 100;
}
