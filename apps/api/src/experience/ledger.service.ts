import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";
import { ActivePolicy, LevelsService } from "./levels.service";
import { levelFromXp } from "./xp-curve";

/** Award kinds (M1 writes task_award + manual_adjustment; M2 adds reversal as negative entries). */
export const XP_AWARD_KINDS = ["task_award", "manual_adjustment", "reversal"] as const;
export type XpAwardKind = (typeof XP_AWARD_KINDS)[number];

export interface AwardXpInput {
  pid: string;
  /** Positive integer XP (bigint-safe). Reversals use reverseXp (negative entries) — M2. */
  deltaXp: bigint | number;
  kind: XpAwardKind;
  taskId?: string;
  /** Idempotency key; requires taskId (completion rows are task-scoped). */
  eventId?: string;
  /**
   * Idempotency scope (PidApp.id of the submitting app). Combined with
   * eventId into the composite dedup key (ANT-430 C1): two apps may reuse
   * the same event_id independently. Empty/absent = ecosystem scope
   * (pre-data M1 backfill sentinel, never a second award path).
   */
  appId?: string;
  reason?: string;
  actorAdminId?: string;
  /** Window label for limit accounting (e.g. "2026-10-22"); default derived from now. */
  periodKey?: string;
  /** Once-per-achievement scope (resource_id variant, R1). */
  resourceId?: string;
}

export interface AwardXpResult {
  pid: string;
  awardedXp: number;
  totalXp: bigint;
  level: number;
  leveledUp: boolean;
  /** True when eventId was already recorded — nothing was written. */
  duplicate: boolean;
}

export interface AppendTaskAwardInput {
  pid: string;
  /** State row as locked/ensured by the caller (null = genesis, created here). */
  state: { pid: string; totalXp: bigint; level: number } | null;
  delta: bigint;
  kind: XpAwardKind;
  taskId?: string;
  eventId?: string;
  appId?: string | null;
  resourceId?: string | null;
  reason?: string | null;
  actorAdminId?: string | null;
  periodKey?: string;
  policy: ActivePolicy;
}

export interface AppendTaskAwardResult {
  newTotal: bigint;
  newLevel: number;
  prevLevel: number;
}

export interface ReconciliationMismatch {
  pid: string;
  ledgerTotal: bigint;
  stateTotal: bigint | null;
}

export interface ManualAdjustInput {
  pid: string;
  /** Positive integer XP to credit. */
  deltaXp: bigint | number;
  /** REQUIRED (F4): empty/whitespace reasons are refused with 400. */
  reason: string;
  /** REQUIRED (F4): the acting admin PID (audit actor). */
  actorAdminId: string;
}

export interface ReversalInput {
  pid: string;
  /** Positive integer XP to debit (stored as a NEW negative ledger entry — W1). */
  amount: bigint | number;
  /** REQUIRED (F4): empty/whitespace reasons are refused with 400. */
  reason: string;
  /** REQUIRED (F4): the acting admin PID (audit actor). */
  actorAdminId: string;
  /** Optional audit link to the original entry being reversed. */
  originalEntryId?: string;
}

const MAX_ID_LEN = 128;
const MAX_REASON_LEN = 512;

function toDelta(delta: bigint | number): bigint {
  const d = typeof delta === "bigint" ? delta : BigInt(Math.floor(delta));
  if (d <= 0n) throw new BadRequestException("deltaXp must be a positive integer");
  return d;
}

/**
 * ANT-89 M1 — append-only XP journal + UserXpState maintenance.
 *
 * Every award runs in ONE Prisma interactive transaction (R2): the
 * UserXpState row is locked with SELECT FOR UPDATE before the ledger append,
 * so concurrent awards serialize on the row and read-modify-write races are
 * impossible. M3 extends the same transaction with quota/org locks in fixed
 * order state → quota → org quota. No HTTP intake exists in M1 (hard gate) —
 * this service is the internal primitive the M3 event pipeline will call.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
  ) {}

  private validateInput(input: AwardXpInput): { pid: string; delta: bigint } {
    const pid = input.pid.trim().toLowerCase();
    if (!isPid(pid)) throw new BadRequestException("Invalid pid");
    const delta = toDelta(input.deltaXp);
    if (!XP_AWARD_KINDS.includes(input.kind)) throw new BadRequestException(`Unknown award kind: ${input.kind}`);
    if (input.eventId !== undefined && (input.eventId.length === 0 || input.eventId.length > MAX_ID_LEN)) {
      throw new BadRequestException("eventId must be 1-128 chars");
    }
    if (input.eventId !== undefined && !input.taskId) {
      throw new BadRequestException("eventId requires taskId");
    }
    if (input.taskId !== undefined && (input.taskId.length === 0 || input.taskId.length > MAX_ID_LEN)) {
      throw new BadRequestException("taskId must be 1-128 chars");
    }
    if (input.appId !== undefined && (input.appId.length === 0 || input.appId.length > MAX_ID_LEN)) {
      throw new BadRequestException("appId must be 1-128 chars");
    }
    if (input.reason !== undefined && input.reason.length > MAX_REASON_LEN) {
      throw new BadRequestException("reason too long (max 512)");
    }
    return { pid, delta };
  }

  /**
   * Shared award writer (M1 awardXp + M3 intake pipeline). The caller owns
   * the transaction, the row locks, and all preconditions (dedup, quotas,
   * verification); this performs ONLY the journal append + state maintenance
   * so both paths stay byte-identical. Creates the genesis state row when
   * the caller locked a missing pid.
   */
  async appendTaskAward(
    tx: Prisma.TransactionClient,
    input: AppendTaskAwardInput,
  ): Promise<AppendTaskAwardResult> {
    const { pid, delta } = input;
    let state = input.state;
    if (!state) {
      state = await tx.userXpState.create({
        data: { pid, totalXp: 0n, level: 1, policyVersionId: input.policy.policy.id },
      });
    }
    const prevLevel = state.level;
    const newTotal = state.totalXp + delta;
    const newLevel = levelFromXp(newTotal, input.policy.thresholds);

    const entry = await tx.xpLedgerEntry.create({
      data: {
        pid,
        deltaXp: delta,
        balanceAfter: newTotal,
        levelAfter: newLevel,
        kind: input.kind,
        taskId: input.taskId ?? null,
        eventId: input.eventId ?? null,
        appId: input.appId ?? null,
        reason: input.reason ?? null,
        actorAdminId: input.actorAdminId ?? null,
        policyVersionId: input.policy.policy.id,
      },
    });

    if (input.eventId && input.taskId) {
      const task = await tx.xpTask.findUnique({ where: { id: input.taskId } });
      if (!task) throw new NotFoundException(`Unknown task: ${input.taskId}`);
      await tx.xpTaskCompletion.create({
        data: {
          pid,
          taskId: input.taskId,
          periodKey: input.periodKey ?? new Date().toISOString().slice(0, 10),
          appId: input.appId ?? "",
          eventId: input.eventId,
          isOnce: task.recurring === "once",
          resourceId: input.resourceId ?? null,
          awardedEntryId: entry.id,
        },
      });
    }

    await tx.userXpState.update({
      where: { pid },
      data: { totalXp: newTotal, level: newLevel, policyVersionId: input.policy.policy.id },
    });

    return { newTotal, newLevel, prevLevel };
  }

  async awardXp(input: AwardXpInput): Promise<AwardXpResult> {
    const { pid, delta } = this.validateInput(input);
    const active = await this.levels.getActivePolicy();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // R2 fixed lock order, first: the user's state row.
        const locked = await tx.$queryRaw<Array<{ pid: string }>>(
          Prisma.sql`SELECT "pid" FROM "user_xp_states" WHERE "pid" = ${pid} FOR UPDATE`,
        );
        let state =
          locked.length > 0
            ? await tx.userXpState.findUniqueOrThrow({ where: { pid } })
            : await tx.userXpState.create({
                data: { pid, totalXp: 0n, level: 1, policyVersionId: active.policy.id },
              });

        // Idempotency fast path, scoped per app (ANT-430 C1): the dedup key
        // is (appId, eventId), so a colliding event_id from another app is
        // NOT a duplicate (race path handled via P2002 below).
        if (input.eventId) {
          const appScope = input.appId ?? "";
          const existing = await tx.xpTaskCompletion.findUnique({ where: { appId_eventId: { appId: appScope, eventId: input.eventId } } });
          if (existing) {
            const current = await tx.userXpState.findUniqueOrThrow({ where: { pid } });
            return {
              pid,
              awardedXp: 0,
              totalXp: current.totalXp,
              level: current.level,
              leveledUp: false,
              duplicate: true,
            };
          }
        }

        const prevLevel = state.level;
        const written = await this.appendTaskAward(tx, {
          pid,
          state,
          delta,
          kind: input.kind,
          taskId: input.taskId,
          eventId: input.eventId,
          appId: input.appId,
          resourceId: input.resourceId,
          reason: input.reason,
          actorAdminId: input.actorAdminId,
          periodKey: input.periodKey,
          policy: active,
        });
        const newTotal = written.newTotal;
        const newLevel = written.newLevel;

        return {
          pid,
          awardedXp: Number(delta),
          totalXp: newTotal,
          level: newLevel,
          leveledUp: newLevel > prevLevel,
          duplicate: false,
        };
      });
    } catch (e) {
      // Lost a race: genesis insert or (appId,eventId) insert collided.
      // Re-read — the winner's rows are authoritative; a colliding
      // (appId,eventId) is a duplicate, never a second award.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        this.logger.debug(`awardXp race for ${pid} (target: ${(e.meta as { target?: unknown })?.target}): resolving as duplicate/genesis`);
        if (input.eventId) {
          const state = await this.prisma.userXpState.findUnique({ where: { pid } });
          if (state) {
            return { pid, awardedXp: 0, totalXp: state.totalXp, level: state.level, leveledUp: false, duplicate: true };
          }
        }
        // Genesis race without eventId: retry once — the row now exists.
        if (!input.eventId) return this.awardXp(input);
      }
      throw e;
    }
  }

  /**
   * M2 admin manual adjustment (F4): positive credit with server-enforced
   * reason + audit actor. Reason/actor are NOT NULL by API contract — the
   * columns stay nullable for pre-existing task_award rows (backward-compatible;
   * only manual_adjustment/reversal kinds require them).
   */
  async adjustXp(input: ManualAdjustInput): Promise<AwardXpResult> {
    const pid = input.pid.trim().toLowerCase();
    if (!isPid(pid)) throw new BadRequestException("Invalid pid");
    const delta = toDelta(input.deltaXp);
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new BadRequestException("reason is required for manual adjustments");
    if (reason.length > MAX_REASON_LEN) throw new BadRequestException("reason too long (max 512)");
    const actor = (input.actorAdminId ?? "").trim();
    if (!actor) throw new BadRequestException("actorAdminId is required for manual adjustments");
    const active = await this.levels.getActivePolicy();
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ pid: string }>>(
        Prisma.sql`SELECT "pid" FROM "user_xp_states" WHERE "pid" = ${pid} FOR UPDATE`,
      );
      let state =
        locked.length > 0
          ? await tx.userXpState.findUniqueOrThrow({ where: { pid } })
          : await tx.userXpState.create({
              data: { pid, totalXp: 0n, level: 1, policyVersionId: active.policy.id },
            });
      const prevLevel = state.level;
      const newTotal = state.totalXp + delta;
      const newLevel = levelFromXp(newTotal, active.thresholds);
      await tx.xpLedgerEntry.create({
        data: {
          pid,
          deltaXp: delta,
          balanceAfter: newTotal,
          levelAfter: newLevel,
          kind: "manual_adjustment",
          reason,
          actorAdminId: actor,
          policyVersionId: active.policy.id,
        },
      });
      state = await tx.userXpState.update({
        where: { pid },
        data: { totalXp: newTotal, level: newLevel, policyVersionId: active.policy.id },
      });
      return {
        pid,
        awardedXp: Number(delta),
        totalXp: state.totalXp,
        level: state.level,
        leveledUp: state.level > prevLevel,
        duplicate: false,
      };
    });
  }

  /**
   * M2 reversal (waiver W1, F4): a debit recorded as a NEW negative ledger
   * entry — history is never rewritten. Reason + actor required (400
   * otherwise); reversals that would drive the balance below zero are
   * refused with 400. Append-only: no update/delete path exists on
   * XpLedgerEntry anywhere in this module (locked by test).
   */
  async reverseXp(input: ReversalInput): Promise<AwardXpResult> {
    const pid = input.pid.trim().toLowerCase();
    if (!isPid(pid)) throw new BadRequestException("Invalid pid");
    const amount = toDelta(input.amount);
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new BadRequestException("reason is required for reversals");
    if (reason.length > MAX_REASON_LEN) throw new BadRequestException("reason too long (max 512)");
    const actor = (input.actorAdminId ?? "").trim();
    if (!actor) throw new BadRequestException("actorAdminId is required for reversals");
    const active = await this.levels.getActivePolicy();
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ pid: string }>>(
        Prisma.sql`SELECT "pid" FROM "user_xp_states" WHERE "pid" = ${pid} FOR UPDATE`,
      );
      let state =
        locked.length > 0
          ? await tx.userXpState.findUniqueOrThrow({ where: { pid } })
          : await tx.userXpState.create({
              data: { pid, totalXp: 0n, level: 1, policyVersionId: active.policy.id },
            });
      const newTotal = state.totalXp - amount;
      if (newTotal < 0n) throw new BadRequestException("reversal exceeds balance");
      const newLevel = levelFromXp(newTotal, active.thresholds);
      const prevLevel = state.level;
      await tx.xpLedgerEntry.create({
        data: {
          pid,
          deltaXp: -amount,
          balanceAfter: newTotal,
          levelAfter: newLevel,
          kind: "reversal",
          reason: input.originalEntryId ? `reversal of ${input.originalEntryId}: ${reason}` : reason,
          actorAdminId: actor,
          policyVersionId: active.policy.id,
        },
      });
      state = await tx.userXpState.update({
        where: { pid },
        data: { totalXp: newTotal, level: newLevel, policyVersionId: active.policy.id },
      });
      return {
        pid,
        awardedXp: Number(-amount),
        totalXp: state.totalXp,
        level: state.level,
        leveledUp: false,
        duplicate: false,
      };
    });
  }

  /**
   * Reconciliation (R2/R4 recovery job primitive): sum(ledger.deltaXp) per
   * pid MUST equal UserXpState.totalXp. PIDs with no state row count as 0
   * (lazy genesis) — only a nonzero ledger sum without a state row mismatches.
   */
  async reconcile(pid?: string): Promise<{ ok: boolean; mismatches: ReconciliationMismatch[] }> {
    const sums = await this.prisma.xpLedgerEntry.groupBy({
      by: ["pid"],
      where: pid ? { pid } : undefined,
      _sum: { deltaXp: true },
    });
    const pids = pid ? [pid, ...sums.map((s) => s.pid)] : sums.map((s) => s.pid);
    const states = await this.prisma.userXpState.findMany({ where: { pid: { in: [...new Set(pids)] } } });
    const byPid = new Map(states.map((s) => [s.pid, s.totalXp]));
    const mismatches: ReconciliationMismatch[] = [];
    for (const s of sums) {
      const ledgerTotal = s._sum.deltaXp ?? 0n;
      const stateTotal = byPid.get(s.pid) ?? null;
      if (stateTotal === null ? ledgerTotal !== 0n : stateTotal !== ledgerTotal) {
        mismatches.push({ pid: s.pid, ledgerTotal, stateTotal });
      }
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}
