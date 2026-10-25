import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import {
  MVP_EVENT_TYPES,
  validateEventTypeAllowlist,
} from "./catalog";
import {
  SetXpPermissionDto,
  SuspendAppDto,
  UpsertQuotaDto,
} from "./experience-admin.dto";
import { LedgerService } from "./ledger.service";
import { checkGrantEnvelope, requireActiveAdmin } from "./experience-admin-guards";

export const XP_PERMISSION_EVENT_CATALOG = [...MVP_EVENT_TYPES];

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
    private readonly ledger: LedgerService,
    private readonly security: SecurityEventService,
  ) {}

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
    if (confirmedBy) await requireActiveAdmin(this.prisma, confirmedBy);
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
    if (confirmedBy) await requireActiveAdmin(this.prisma, confirmedBy);
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
    if (confirmedBy) await requireActiveAdmin(this.prisma, confirmedBy);
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
}
