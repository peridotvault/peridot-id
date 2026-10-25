// ANT-456 — auditable backfill-run procedure (plan §3.5), replacing the
// permanent PID_XP_MIGRATION_ENABLED env var with an explicit,
// resumable, idempotent admin-triggered job.
//
// - dryRun=true (default): preview + reconcile, ZERO XP-state writes.
//   policyVersion optional (defaults to the ACTIVE policy).
// - dryRun=false: execution, still behind the legacy migration env gate
//   (flag untouched, plan req 5) AND the admin guard. Pages execute via
//   PolicyBackfillService (idempotent + resumable); the run row tracks
//   cursor/progress so a crash resumes where it stopped.
// - Every request creates a BackfillRun row: run history IS the audit
//   trail, plus SecurityEvent rows for request/completion/failure.

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { LevelsService } from "../experience/levels.service";
import { PolicyBackfillService } from "../experience/policy-backfill.service";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export type BackfillRunStatus = "preview" | "queued" | "running" | "done" | "failed";

export interface RequestBackfillRunOpts {
  dryRun?: boolean;
  policyVersion?: string;
  cursor?: string;
  batchSize?: number;
}

@Injectable()
export class BackfillRunService {
  private readonly logger = new Logger(BackfillRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
    private readonly backfill: PolicyBackfillService,
    private readonly security: SecurityEventService,
  ) {}

  /** Resolve a policyVersion input (version number string or policy id). */
  private async resolvePolicy(policyVersion?: string): Promise<{ id: string; version: number }> {
    if (policyVersion) {
      if (/^\d+$/.test(policyVersion)) {
        const row = await this.prisma.xpPolicyVersion.findUnique({ where: { version: Number(policyVersion) } });
        if (!row) throw new NotFoundException({ error: "not_found", message: `policy version ${JSON.stringify(policyVersion)} not found` });
        return { id: row.id, version: row.version };
      }
      const row = await this.prisma.xpPolicyVersion.findUnique({ where: { id: policyVersion } });
      if (!row) throw new NotFoundException({ error: "not_found", message: `policy ${JSON.stringify(policyVersion)} not found` });
      return { id: row.id, version: row.version };
    }
    const active = await this.levels.getActivePolicy().catch(() => null);
    if (!active) throw new BadRequestException({ error: "validation_error", message: "no active policy — pass policyVersion explicitly" });
    return { id: active.policy.id, version: active.policy.version };
  }

  async requestRun(actor: string, opts: RequestBackfillRunOpts) {
    const dryRun = opts.dryRun ?? true;
    if (!dryRun && !opts.policyVersion) {
      throw new BadRequestException({ error: "validation_error", message: "policyVersion is required when dryRun=false" });
    }
    const policy = await this.resolvePolicy(opts.policyVersion);

    if (dryRun) {
      // Read-only: plan + reconcile. Never touches XP state.
      const plan = await this.backfill.planBackfill(policy.id);
      const verify = await this.backfill.verifyBackfill();
      const run = await this.prisma.backfillRun.create({
        data: {
          policyId: policy.id,
          policyVersion: policy.version,
          status: "preview",
          cursor: null,
          dryRun: true,
          processed: plan.pending,
          updated: 0,
          actor,
          finishedAt: new Date(),
        },
      });
      await this.security.log(actor, "admin.xp.backfill.previewed", {
        runId: run.id,
        policyId: policy.id,
        version: policy.version,
        pending: plan.pending,
        reconcileOk: verify.ok,
      });
      return {
        runId: run.id,
        status: "preview" as const,
        cursor: null,
        policyId: policy.id,
        policyVersion: String(policy.version),
        preview: { ...plan, reconcileOk: verify.ok, unstamped: verify.unstamped },
      };
    }

    // Execution: still behind the legacy env gate (flag untouched).
    if (!this.backfill.migrationEnabled()) {
      throw new ServiceUnavailableException({ error: "unavailable", message: "XP migration tooling is disabled" });
    }
    const run = await this.prisma.backfillRun.create({
      data: {
        policyId: policy.id,
        policyVersion: policy.version,
        status: "running",
        cursor: opts.cursor ?? null,
        dryRun: false,
        actor,
      },
    });
    await this.security.log(actor, "admin.xp.backfill.run_requested", {
      runId: run.id,
      policyId: policy.id,
      version: policy.version,
      cursor: opts.cursor ?? null,
    });

    let cursor = opts.cursor ?? "";
    let processed = 0;
    let updated = 0;
    try {
      for (;;) {
        const page = await this.backfill.runBackfill(actor, policy.id, {
          ...(cursor ? { cursor } : {}),
          ...(opts.batchSize ? { batchSize: opts.batchSize } : {}),
        });
        processed += page.processed;
        updated += page.updated;
        cursor = page.nextCursor ?? "";
        await this.prisma.backfillRun.update({
          where: { id: run.id },
          data: { cursor: page.nextCursor, processed, updated, status: page.done ? "done" : "running" },
        });
        if (page.done) break;
      }
      const finished = await this.prisma.backfillRun.update({
        where: { id: run.id },
        data: { status: "done", cursor: null, finishedAt: new Date() },
      });
      const verify = await this.backfill.verifyBackfill();
      await this.security.log(actor, "admin.xp.backfill.run_completed", {
        runId: run.id,
        policyId: policy.id,
        version: policy.version,
        processed,
        updated,
        reconcileOk: verify.ok,
      });
      return {
        runId: run.id,
        status: finished.status as BackfillRunStatus,
        cursor: null,
        policyId: policy.id,
        policyVersion: String(policy.version),
        processed,
        updated,
        reconcileOk: verify.ok,
      };
    } catch (e) {
      await this.prisma.backfillRun
        .update({ where: { id: run.id }, data: { status: "failed", cursor: cursor || null, processed, updated, finishedAt: new Date() } })
        .catch((dbErr) => this.logger.warn(`backfill run ${run.id} failure bookkeeping failed: ${(dbErr as Error).message}`));
      await this.security.log(actor, "admin.xp.backfill.run_failed", {
        runId: run.id,
        policyId: policy.id,
        version: policy.version,
        processed,
        updated,
        cause: (e as Error).message,
      });
      throw e;
    }
  }

  async listRuns(limit = 20) {
    const rows = await this.prisma.backfillRun.findMany({
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(Math.floor(limit) || 20, 1), 100),
    });
    return {
      runs: rows.map((r) => ({
        runId: r.id,
        policyId: r.policyId,
        policyVersion: String(r.policyVersion),
        status: r.status,
        actor: r.actor,
        dryRun: r.dryRun,
        processed: r.processed,
        updated: r.updated,
        cursor: r.cursor,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
    };
  }
}
