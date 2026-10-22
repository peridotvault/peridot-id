import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { LedgerService } from "./ledger.service";
import { LevelsService } from "./levels.service";
import { levelFromXp } from "./xp-curve";

/** Release gate for migration EXECUTION (R4): same board gate as XP
 * awarding — no backfill runs until Tobias sign-off + Tristan evidence on
 * the parent. Planning (read-only) is always available. Exact-"true"
 * match, fail-closed. */
export const XP_MIGRATION_ENABLED_KEY = "PID_XP_MIGRATION_ENABLED";

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

export interface BackfillPage {
  policyId: string;
  version: number;
  processed: number;
  updated: number;
  nextCursor: string | null;
  done: boolean;
}

/**
 * ANT-89 M3 (ANT-441) — policy-migration tooling (plan R4).
 *
 * Draft → materialize → impact-preview → single-txn activation already ship
 * in the admin API (M2); this service owns the EXECUTION side:
 * lazy+checkpointed backfill with policyVersionId stamping, rollback, and
 * recovery — all behind the M3 release gate.
 *
 * Invariants (proven by tests):
 * - Ledger XP totals are NEVER rewritten — the backfill updates ONLY
 *   UserXpState.{level, policyVersionId}. Reconciliation before/after is
 *   identical.
 * - Idempotent + resumable: re-running a page (or the whole job) converges;
 *   pages are cursor-keyed (pid ASC), so a crash resumes at nextCursor.
 * - Rollback never mutates version history: it drafts a NEW version copying
 *   the prior formula/thresholds, then follows the standard
 *   activate + backfill path (M2 refuses to reactivate superseded rows).
 * - Recovery = reconcile() (ledger↔state) + unstamped-row scan.
 */
@Injectable()
export class PolicyBackfillService {
  private readonly logger = new Logger(PolicyBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
    private readonly ledger: LedgerService,
    private readonly security: SecurityEventService,
    private readonly config: ConfigService,
  ) {}

  migrationEnabled(): boolean {
    return this.config.get<string>(XP_MIGRATION_ENABLED_KEY, "false") === "true";
  }

  /** Read-only migration plan: how many state rows still map the old policy. */
  async planBackfill(policyId: string) {
    const policy = await this.prisma.xpPolicyVersion.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException("policy not found");
    const thresholdCount = await this.prisma.xpLevelThreshold.count({ where: { policyVersionId: policyId } });
    if (thresholdCount === 0) throw new BadRequestException("policy has no materialized thresholds — materialize first");
    const [totalStates, stamped] = await Promise.all([
      this.prisma.userXpState.count(),
      this.prisma.userXpState.count({ where: { policyVersionId: policyId } }),
    ]);
    const active = await this.levels.getActivePolicy().catch(() => null);
    return {
      policyId,
      version: policy.version,
      isActive: active?.policy.id === policyId,
      activeVersion: active?.policy.version ?? null,
      thresholdCount,
      totalStates,
      stamped,
      pending: totalStates - stamped,
    };
  }

  /**
   * Execute one backfill page (gated). Each page commits in a single short
   * transaction; pages chain via nextCursor until done=true.
   */
  async runBackfill(
    actorAdminId: string,
    policyId: string,
    opts?: { cursor?: string; batchSize?: number },
  ): Promise<BackfillPage> {
    if (!this.migrationEnabled()) throw new ServiceUnavailableException("XP migration tooling is disabled");
    const batchSize = Math.min(Math.max(Math.floor(opts?.batchSize ?? DEFAULT_BATCH) || DEFAULT_BATCH, 1), MAX_BATCH);
    const cursor = opts?.cursor ?? "";
    const policy = await this.prisma.xpPolicyVersion.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException("policy not found");
    const rows = await this.prisma.xpLevelThreshold.findMany({
      where: { policyVersionId: policyId },
      orderBy: { level: "asc" },
    });
    if (rows.length === 0) throw new BadRequestException("policy has no materialized thresholds — materialize first");
    const thresholds = rows.map((r) => ({ level: r.level, cumulativeXp: Number(r.cumulativeXp) }));

    const page = await this.prisma.userXpState.findMany({
      where: cursor ? { pid: { gt: cursor } } : undefined,
      orderBy: { pid: "asc" },
      take: batchSize + 1,
    });
    const slice = page.slice(0, batchSize);
    const done = page.length <= batchSize;
    let updated = 0;
    if (slice.length > 0) {
      const writes = [];
      for (const s of slice) {
        const newLevel = levelFromXp(s.totalXp, thresholds);
        if (newLevel !== s.level || s.policyVersionId !== policyId) {
          writes.push(
            this.prisma.userXpState.update({
              where: { pid: s.pid },
              data: { level: newLevel, policyVersionId: policyId },
            }),
          );
          updated++;
        }
      }
      // Single short transaction per page (never one giant txn — R4).
      if (writes.length > 0) await this.prisma.$transaction(writes);
    }
    await this.security.log(actorAdminId, "admin.xp.backfill.ran", {
      policyId,
      version: policy.version,
      processed: slice.length,
      updated,
      ...(done ? {} : { nextCursor: slice[slice.length - 1]?.pid ?? cursor }),
      done,
    });
    return {
      policyId,
      version: policy.version,
      processed: slice.length,
      updated,
      nextCursor: done ? null : (slice[slice.length - 1]?.pid ?? cursor),
      done,
    };
  }

  /**
   * Rollback preparation: copies a prior (non-active) version's formula +
   * materialized thresholds into a FRESH draft version, ready for the
   * standard activate + backfill path. Version rows are append-only — the
   * superseded row is never revived (M2 invariant holds).
   */
  async rollbackDraft(actorAdminId: string, version: number) {
    const source = await this.prisma.xpPolicyVersion.findUnique({ where: { version } });
    if (!source) throw new NotFoundException("policy version not found");
    const active = await this.levels.getActivePolicy().catch(() => null);
    if (active && active.policy.id === source.id) throw new BadRequestException("version is already active — nothing to roll back");
    const sourceRows = await this.prisma.xpLevelThreshold.findMany({
      where: { policyVersionId: source.id },
      orderBy: { level: "asc" },
    });
    if (sourceRows.length === 0) throw new BadRequestException("source version has no materialized thresholds");
    const max = await this.prisma.xpPolicyVersion.aggregate({ _max: { version: true } });
    const next = (max._max.version ?? 0) + 1;
    const created = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.xpPolicyVersion.create({
        data: {
          version: next,
          formula: source.formula as Prisma.InputJsonValue,
          maxLevel: source.maxLevel,
          createdBy: `${actorAdminId} (rollback of v${source.version})`,
        },
      });
      await tx.xpLevelThreshold.createMany({
        data: sourceRows.map((r) => ({ policyVersionId: draft.id, level: r.level, cumulativeXp: r.cumulativeXp })),
      });
      return draft;
    });
    await this.security.log(actorAdminId, "admin.xp.backfill.rollback_drafted", {
      sourceVersion: source.version,
      draftId: created.id,
      draftVersion: next,
      thresholdCount: sourceRows.length,
    });
    return { policyId: created.id, version: next, sourceVersion: source.version, thresholdCount: sourceRows.length };
  }

  /**
   * Recovery verification: ledger↔state reconciliation PLUS the
   * unstamped-row scan (states not yet mapped to the ACTIVE policy).
   */
  async verifyBackfill() {
    const reconcile = await this.ledger.reconcile();
    const active = await this.levels.getActivePolicy().catch(() => null);
    const unstamped = active
      ? await this.prisma.userXpState.count({ where: { policyVersionId: { not: active.policy.id } } })
      : await this.prisma.userXpState.count();
    return {
      reconcileOk: reconcile.ok,
      mismatches: reconcile.mismatches.map((m) => ({ ...m, ledgerTotal: m.ledgerTotal.toString(), stateTotal: m.stateTotal?.toString() ?? null })),
      activeVersion: active?.policy.version ?? null,
      unstamped,
      ok: reconcile.ok && unstamped === 0,
    };
  }
}
