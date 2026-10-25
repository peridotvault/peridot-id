import { BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { XpSettingsService } from "../settings/xp-settings.service";
import type { EffectiveIntake } from "../settings/xp-settings.service";
import { AuthedXpApp } from "./app-credential.guard";
import { EVENT_TYPE_FORMAT, validateChecker } from "./catalog";
import { SubmitEventDto } from "./events.dto";
import { EvidenceService } from "./evidence.service";
import { LedgerService } from "./ledger.service";
import { LevelsService } from "./levels.service";
import { QuotaService } from "./quota.service";
import { VerificationService } from "./verification.service";

export type IntakeStatus = "awarded" | "duplicate" | "rejected";

export interface IntakeResult {
  status: IntakeStatus;
  awarded_xp: number;
  /** Authoritative level after processing (present on awarded/duplicate). */
  level?: number;
  /** Machine-readable rejection cause (generic where privacy demands it). */
  reason?: string;
  leveledUp?: boolean;
}

/** Generic rejection cause shared by unknown-subject and failed-verification
 * (Tobias F5: no PID oracle — callers cannot distinguish "no such user"
 * from "activity not verifiable"). */
export const NOT_ELIGIBLE = "not_eligible";

function windowStarts(now: Date): { day: Date; week: Date; month: Date } {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (day.getUTCDay() + 6) % 7;
  const week = new Date(day.getTime() - mondayOffset * 86400000);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { day, week, month };
}

const toSafeNumber = (v: bigint): number => (v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v));

/**
 * ANT-89 M3 (ANT-441) — 10-step event intake pipeline (plan S4).
 *
 * 1. authenticate (AppCredentialGuard, before entry — body credentials only)
 * 2. verify app active + Verified — re-read IN the txn (F2)
 * 3. XP permission + approved event_type — re-read IN the txn (F2)
 * 4. approved event_type → active task (scope precedence: app-scoped wins;
 *    status + window + checker re-read IN the txn)
 * 5. backend verification via EvidenceService (MVP catalog only; anything
 *    third-party-attested-only is REJECTED, never awarded)
 * 6. dedup by (appId, eventId) + per-task cooldowns
 * 7. task/app/org/user limits enforced in ONE txn (lock order
 *    UserXpState → XpQuota → XpOrgQuota; sums read after the locks — R2)
 * 8. server-side XP from XpTask.xpReward (DTO carries no xp field — F6)
 * 9. append ledger + update state (shared writer with LedgerService)
 * 10. return { status, awarded_xp, level, reason? }
 *
 * Locking note (F2 TOCTOU + Tobias re-review S1): predicates are read in-txn
 * (READ COMMITTED sees committed admin revokes) and acted on immediately;
 * serialization against concurrent awards comes from the three row locks in
 * plan order; then — because those locks do NOT serialize against admin
 * writes to PidApp/XpTask — standing + task status/window/checker/scope are
 * RE-VERIFIED post-lock immediately before the append (S1). A revoke/disable
 * landing mid-flight therefore blocks THIS award; residual race is a single
 * statement. Unknown subjects and failed verifications share ONE client
 * reason (`not_eligible`) — no PID oracle (F5). Rejections write
 * suspicious-feed rows (F7); awards write the security audit event in-txn.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
    private readonly ledger: LedgerService,
    private readonly verification: VerificationService,
    private readonly quotas: QuotaService,
    private readonly evidence: EvidenceService,
    private readonly security: SecurityEventService,
    private readonly xpSettings: XpSettingsService,
  ) {}

  async submitEvent(dto: SubmitEventDto, authed: AuthedXpApp): Promise<IntakeResult> {
    if (!authed) throw new ForbiddenException("App is not permitted to submit events");
    // Effective intake (plan §3.3): only the kill-switches (xp.suspend.global
    // / xp.suspend.<appId>) can deny; any settings read failure also denies
    // (fail-closed). XpSettingsService never throws by contract (F4), but the
    // gate is wrapped defensively: a throwing settings layer must still deny.
    let gate: EffectiveIntake;
    try {
      gate = await this.xpSettings.effectiveIntake(authed.id);
    } catch (e) {
      await this.feed({
        signal: "xp.intake.disabled_reject",
        appId: authed.id,
        detail: { clientId: authed.clientId, gateError: (e as Error).message, source: "defaults-fallback" },
      });
      throw new ServiceUnavailableException("XP intake is disabled");
    }
    if (!gate.allowed) {
      await this.feed({
        signal: "xp.intake.disabled_reject",
        appId: authed.id,
        detail: { clientId: authed.clientId, ...gate.breakdown, source: gate.source },
      });
      throw new ServiceUnavailableException("XP intake is disabled");
    }
    if (!EVENT_TYPE_FORMAT.test(dto.event_type)) throw new BadRequestException("event_type must match ^[a-z][a-z0-9_]{2,63}$");
    const pid = dto.user_id.trim().toLowerCase();
    // Format is boundary validation (400 reveals nothing about existence);
    // EXISTENCE is never oracled — unknown subjects share `not_eligible`.
    if (!isPid(pid)) throw new BadRequestException("user_id must be a valid PID");
    const eventId = dto.event_id.trim();
    if (eventId.length === 0 || eventId.length > 128) throw new BadRequestException("event_id must be 1-128 chars");

    const verdict = await this.runPipelineSafe({ pid, eventId, eventType: dto.event_type, resourceId: dto.resource_id, app: authed });
    if (verdict.signal) {
      await this.feed({ signal: verdict.signal, pid, appId: authed.id, detail: verdict.detail });
    }
    const { signal: _s, detail: _d, ...result } = verdict;
    return result;
  }

  private async feed(input: { signal: string; pid?: string; appId?: string | null; detail?: unknown }): Promise<void> {
    try {
      await this.prisma.xpSuspiciousActivity.create({
        data: {
          pid: input.pid ?? null,
          appId: input.appId ?? null,
          signal: input.signal,
          detail: (input.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      // Telemetry must never fail intake: the award already committed.
      this.logger.warn(`suspicious-feed write failed (${input.signal}): ${(e as Error).message}`);
    }
  }

  private async runPipelineSafe(input: {
    pid: string;
    eventId: string;
    eventType: string;
    resourceId?: string;
    app: AuthedXpApp;
  }): Promise<IntakeResult & { signal?: string; detail?: unknown }> {
    // Bounded retry (max 2 attempts). A P2002 here is ALWAYS a race, never a
    // validation error: either our (appId,eventId) insert collided (the
    // winner's award stands → duplicate) or state genesis collided while our
    // event is still unrecorded (retry — the row now exists).
    // A same-event collision resolves duplicate on the FIRST catch; a
    // genesis-only collision retries once and then throws rather than
    // misreporting.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.runPipeline(input);
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
        this.logger.debug(`intake race for ${input.pid} (target: ${(e.meta as { target?: unknown })?.target})`);
        const completion = await this.prisma.xpTaskCompletion.findUnique({
          where: { appId_eventId: { appId: input.app.id, eventId: input.eventId } },
        });
        if (completion) {
          const state = await this.prisma.userXpState.findUnique({ where: { pid: input.pid } });
          return { status: "duplicate", awarded_xp: 0, level: state?.level ?? 1, reason: "duplicate_event" };
        }
        if (attempt === 0) continue;
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  private async runPipeline(input: {
    pid: string;
    eventId: string;
    eventType: string;
    resourceId?: string;
    app: AuthedXpApp;
  }): Promise<IntakeResult & { signal?: string; detail?: unknown }> {
    const { pid, eventId, eventType, resourceId, app } = input;
    return this.prisma.$transaction(async (tx) => {
        const now = new Date();

        // Steps 2–3: re-read app standing on the (unlocked — see class note)
        // fresh row; admin revokes commit independently and are seen here.
        const fresh = await tx.pidApp.findUnique({ where: { id: app.id } });
        const standing = this.verification.canSubmitEvents(
          fresh
            ? { isActive: fresh.isActive, isVerified: fresh.isVerified, xpEnabled: fresh.xpEnabled, approvedEventTypes: fresh.approvedEventTypes }
            : null,
          eventType,
        );
        if (!standing.canSubmitEvents) {
          const denied: IntakeResult & { signal: string; detail: unknown } = {
            status: "rejected",
            awarded_xp: 0,
            reason: "app_not_permitted",
            signal: "xp.intake.permission_denied",
            detail: { clientId: fresh?.clientId ?? app.clientId, reason: standing.reason ?? "unknown" },
          };
          if (!fresh || !fresh.isActive) throw new ForbiddenException("App is not permitted to submit events");
          return denied;
        }
        const ownerPid = (fresh as { ownerPid: string }).ownerPid;

        // Subject must be a live ecosystem member — but NEVER oracled.
        const identity = await tx.identity.findUnique({ where: { pid } });
        if (!identity || (identity as { status?: string }).status === "deleted") {
          return { status: "rejected", awarded_xp: 0, reason: NOT_ELIGIBLE, signal: "xp.intake.unknown_subject", detail: {} };
        }

        // Step 4: task resolution — key === eventType, app-scoped wins over
        // ecosystem-wide; status + window + checker re-checked in-txn (F2/F8).
        const candidates = await tx.xpTask.findMany({ where: { key: eventType, status: "active" } });
        const scoped = candidates.filter((t) => (t as { scopeAppId?: string | null }).scopeAppId === app.id);
        const eco = candidates.filter((t) => (t as { scopeAppId?: string | null }).scopeAppId == null);
        const task = [...scoped, ...eco][0] as
          | {
              id: string;
              xpReward: number;
              recurring: string;
              lifetimeLimit: number | null;
              dailyLimit: number | null;
              weeklyLimit: number | null;
              monthlyLimit: number | null;
              cooldownSecs: number | null;
              availableFrom: Date | null;
              availableUntil: Date | null;
              verificationChecker: string | null;
              verificationType: string;
              scopeAppId: string | null;
            }
          | undefined;
        if (!task) return { status: "rejected", awarded_xp: 0, reason: "no_active_task" };
        if ((task.availableFrom && now < task.availableFrom) || (task.availableUntil && now > task.availableUntil)) {
          return { status: "rejected", awarded_xp: 0, reason: "task_not_available" };
        }
        const checkerErr = validateChecker(task.verificationType, task.verificationChecker);
        if (checkerErr || !task.verificationChecker) {
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: "task_not_verifiable",
            signal: "xp.intake.checker_drift",
            detail: { taskId: task.id, error: checkerErr ?? "missing checker" },
          };
        }

        // Step 5: backend verification (R3 — fail closed, generic envelope).
        const evidence = await this.evidence.verify(task.verificationChecker, { pid, resourceId }, tx as never);
        if (!evidence.ok) {
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: NOT_ELIGIBLE,
            signal: "xp.intake.unverifiable",
            detail: { taskId: task.id, checker: task.verificationChecker, cause: evidence.reason ?? "failed" },
          };
        }

        // Lock order, first: the user's state row (R2). SELECT ... FOR UPDATE
        // serializes same-pid awards; genesis insert races resolve via P2002.
        const locked = await tx.$queryRaw<Array<{ pid: string }>>(
          Prisma.sql`SELECT "pid" FROM "user_xp_states" WHERE "pid" = ${pid} FOR UPDATE`,
        );
        const state = locked.length > 0 ? await tx.userXpState.findUniqueOrThrow({ where: { pid } }) : null;

        // Step 6: dedup fast path (composite (appId, eventId) — C1).
        const existing = await tx.xpTaskCompletion.findUnique({
          where: { appId_eventId: { appId: app.id, eventId } },
        });
        if (existing) {
          const current = state ?? (await tx.userXpState.findUnique({ where: { pid } }));
          return {
            status: "duplicate",
            awarded_xp: 0,
            level: current?.level ?? 1,
            reason: "duplicate_event",
          };
        }

        // Step 6b: cooldowns (MAX(createdAt) per task+pid).
        const latest = await tx.xpTaskCompletion.findFirst({
          where: { taskId: task.id, pid },
          orderBy: { createdAt: "desc" },
        });
        if (latest && task.cooldownSecs != null && task.cooldownSecs > 0) {
          const elapsed = (now.getTime() - new Date((latest as { createdAt: Date }).createdAt).getTime()) / 1000;
          if (elapsed < task.cooldownSecs) return { status: "rejected", awarded_xp: 0, reason: "cooldown" };
        }

        // Step 7a: task/user limits — counts over the locked window (R1/R2).
        const { day, week, month } = windowStarts(now);
        const [lifetime, daily, weekly, monthly] = await Promise.all([
          tx.xpTaskCompletion.count({ where: { taskId: task.id, pid } }),
          task.dailyLimit != null || task.weeklyLimit != null || task.monthlyLimit != null
            ? tx.xpTaskCompletion.count({ where: { taskId: task.id, pid, createdAt: { gte: day } } })
            : Promise.resolve(0),
          task.weeklyLimit != null ? tx.xpTaskCompletion.count({ where: { taskId: task.id, pid, createdAt: { gte: week } } }) : Promise.resolve(0),
          task.monthlyLimit != null
            ? tx.xpTaskCompletion.count({ where: { taskId: task.id, pid, createdAt: { gte: month } } })
            : Promise.resolve(0),
        ]);
        const taskLimitHit =
          (task.recurring === "once" && lifetime >= 1) ||
          (task.lifetimeLimit != null && lifetime >= task.lifetimeLimit) ||
          (task.dailyLimit != null && daily >= task.dailyLimit) ||
          (task.weeklyLimit != null && weekly >= task.weeklyLimit) ||
          (task.monthlyLimit != null && monthly >= task.monthlyLimit);
        if (taskLimitHit) return { status: "rejected", awarded_xp: 0, reason: "task_limit" };

        // Step 7b: app + org quotas. Lock order, second and third (R2):
        // XpQuota(appId) → XpOrgQuota(ownerPid). Missing rows = unbounded
        // (never materialized just to serialize — nothing to enforce).
        await tx.$queryRaw(Prisma.sql`SELECT "appId" FROM "xp_quotas" WHERE "appId" = ${app.id} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "ownerPid" FROM "xp_org_quotas" WHERE "ownerPid" = ${ownerPid} FOR UPDATE`);
        const [appQuota, orgQuota, ownerApps] = await Promise.all([
          tx.xpQuota.findUnique({ where: { appId: app.id } }),
          tx.xpOrgQuota.findUnique({ where: { ownerPid } }),
          tx.pidApp.findMany({ where: { ownerPid }, select: { id: true } }),
        ]);
        const [appSums, orgSums] = await Promise.all([
          Promise.all([
            tx.xpLedgerEntry.aggregate({ _sum: { deltaXp: true }, where: { appId: app.id, createdAt: { gte: day } } }),
            tx.xpLedgerEntry.aggregate({ _sum: { deltaXp: true }, where: { appId: app.id, createdAt: { gte: week } } }),
            tx.xpLedgerEntry.aggregate({ _sum: { deltaXp: true }, where: { appId: app.id, createdAt: { gte: month } } }),
          ]),
          Promise.all([
            tx.xpLedgerEntry.aggregate({
              _sum: { deltaXp: true },
              where: { appId: { in: ownerApps.map((a) => a.id) }, createdAt: { gte: day } },
            }),
            tx.xpLedgerEntry.aggregate({
              _sum: { deltaXp: true },
              where: { appId: { in: ownerApps.map((a) => a.id) }, createdAt: { gte: week } },
            }),
            tx.xpLedgerEntry.aggregate({
              _sum: { deltaXp: true },
              where: { appId: { in: ownerApps.map((a) => a.id) }, createdAt: { gte: month } },
            }),
          ]),
        ]);
        // Step 8: server-side XP ONLY (F6 — the DTO cannot carry xp).
        const delta = BigInt(task.xpReward);
        const appVerdict = this.quotas.evaluate({
          periodSums: { daily: toSafeNumber(appSums[0]._sum.deltaXp ?? 0n), weekly: toSafeNumber(appSums[1]._sum.deltaXp ?? 0n), monthly: toSafeNumber(appSums[2]._sum.deltaXp ?? 0n) },
          deltaXp: task.xpReward,
          caps: { dailyCap: appQuota?.dailyCap ?? null, weeklyCap: appQuota?.weeklyCap ?? null, monthlyCap: appQuota?.monthlyCap ?? null },
          suspended: appQuota?.suspended ?? false,
          suspendReason: appQuota?.suspendReason ?? null,
        });
        if (!appVerdict.allowed) {
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: appQuota?.suspended ? "suspended" : "quota_exceeded",
            signal: "xp.intake.quota_exceeded",
            detail: { scope: "app", appId: app.id, cause: appVerdict.reason ?? "cap" },
          };
        }
        const orgVerdict = this.quotas.evaluate({
          periodSums: { daily: toSafeNumber(orgSums[0]._sum.deltaXp ?? 0n), weekly: toSafeNumber(orgSums[1]._sum.deltaXp ?? 0n), monthly: toSafeNumber(orgSums[2]._sum.deltaXp ?? 0n) },
          deltaXp: task.xpReward,
          caps: { dailyCap: orgQuota?.dailyCap ?? null, weeklyCap: orgQuota?.weeklyCap ?? null, monthlyCap: orgQuota?.monthlyCap ?? null },
        });
        if (!orgVerdict.allowed) {
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: "quota_exceeded",
            signal: "xp.intake.quota_exceeded",
            detail: { scope: "org", ownerPid, cause: orgVerdict.reason ?? "cap" },
          };
        }

        // S1 (Tobias re-review): post-lock re-verification. The step 2–4
        // reads above raced admin revokes — the FOR UPDATE locks serialize
        // concurrent awards, NOT admin writes to PidApp/XpTask (those paths
        // take no such locks). Re-run the standing + task predicates AFTER
        // all locks are held, immediately before the append, so a revoke /
        // disable landing mid-flight still blocks THIS award. Residual race
        // is a single statement; SERIALIZABLE is not warranted.
        const reFresh = await tx.pidApp.findUnique({ where: { id: app.id } });
        const reStanding = this.verification.canSubmitEvents(
          reFresh
            ? { isActive: reFresh.isActive, isVerified: reFresh.isVerified, xpEnabled: reFresh.xpEnabled, approvedEventTypes: reFresh.approvedEventTypes }
            : null,
          eventType,
        );
        if (!reStanding.canSubmitEvents) {
          if (!reFresh || !reFresh.isActive) throw new ForbiddenException("App is not permitted to submit events");
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: "app_not_permitted",
            signal: "xp.intake.permission_denied",
            detail: { clientId: reFresh.clientId, reason: reStanding.reason ?? "unknown", recheck: true },
          };
        }
        const reTask = await tx.xpTask.findUnique({ where: { id: task.id } });
        const reTaskOk =
          reTask &&
          (reTask as { status: string }).status === "active" &&
          !((reTask as { availableFrom: Date | null }).availableFrom && now < (reTask as { availableFrom: Date }).availableFrom) &&
          !((reTask as { availableUntil: Date | null }).availableUntil && now > (reTask as { availableUntil: Date }).availableUntil) &&
          !validateChecker((reTask as { verificationType: string }).verificationType, (reTask as { verificationChecker: string | null }).verificationChecker) &&
          (reTask as { scopeAppId: string | null }).scopeAppId === task.scopeAppId;
        if (!reTaskOk) {
          return {
            status: "rejected",
            awarded_xp: 0,
            reason: "no_active_task",
            signal: "xp.intake.checker_drift",
            detail: { taskId: task.id, recheck: true },
          };
        }

        // Step 9: append ledger + update state (shared writer with M1/M2).
        // Policy is read here — immediately before the write — so an
        // activation flip mid-flight stamps at most this award stale (the
        // lazy re-level hook heals the mapping on the next read).
        const active = await this.levels.getActivePolicy();
        const written = await this.ledger.appendTaskAward(tx as never, {
          pid,
          state,
          delta,
          kind: "task_award",
          taskId: task.id,
          eventId,
          appId: app.id,
          resourceId,
          periodKey: now.toISOString().slice(0, 10),
          policy: active,
        });
        await this.security.log(
          pid,
          "xp.awarded",
          { appId: app.id, clientId: app.clientId, taskId: task.id, eventId, deltaXp: task.xpReward, level: written.newLevel },
          tx as never,
        );
        return { status: "awarded", awarded_xp: task.xpReward, level: written.newLevel, leveledUp: written.newLevel > written.prevLevel } as const;
      });
  }
}
