import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, XpPolicyVersion } from "@prisma/client";
import { isPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";
import {
  DEFAULT_FORMULA,
  LevelThreshold,
  XpFormula,
  buildThresholds,
  levelFromXp,
  progressFor,
  xpToJsonNumber,
} from "./xp-curve";

/** Wire shape of GET /v1/users/{pid}/level (snake_case per ANT-89 §6). */
export interface LevelView {
  pid: string;
  level: number;
  total_xp: number;
  current_level_xp: number;
  next_level_xp: number | null;
  progress_percentage: number;
}

export interface ActivePolicy {
  policy: XpPolicyVersion;
  formula: XpFormula;
  /** Materialized thresholds, level-ascending. Overrides already applied. */
  thresholds: LevelThreshold[];
}

function parseFormula(raw: unknown): XpFormula {
  const f = (raw ?? {}) as Partial<XpFormula>;
  const base = typeof f.base === "number" && f.base > 0 ? f.base : DEFAULT_FORMULA.base;
  const exponent = typeof f.exponent === "number" && f.exponent > 0 ? f.exponent : DEFAULT_FORMULA.exponent;
  return { base, exponent, rounding: "floor" };
}

/**
 * ANT-89 M1 — policy-versioned level reads + lazy UserXpState genesis.
 *
 * Reads serve the single ACTIVE policy version (activated, not superseded;
 * uniqueness enforced by partial index `xp_policy_versions_single_active`).
 * R4: every level mapping is stamped with its policyVersionId; ledger XP
 * totals are never rewritten — only this mapping changes across versions.
 * Migration/re-level tooling itself ships under the M3 release gate.
 */
@Injectable()
export class LevelsService {
  private readonly logger = new Logger(LevelsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getActivePolicy(): Promise<ActivePolicy> {
    const policy = await this.prisma.xpPolicyVersion.findFirst({
      where: { activatedAt: { not: null }, supersededAt: null },
      orderBy: { version: "desc" },
    });
    if (!policy) throw new NotFoundException("No active XP policy version");
    const formula = parseFormula(policy.formula as unknown);
    const rows = await this.prisma.xpLevelThreshold.findMany({
      where: { policyVersionId: policy.id },
      orderBy: { level: "asc" },
    });
    // DB thresholds are authoritative (they carry per-level overrides);
    // fall back to formula materialization only when a version has no rows
    // yet (draft versions awaiting materialization — never served as active
    // in practice, but fail-open to the formula keeps reads deterministic).
    const maxLevel = policy.maxLevel ?? rows.length;
    const thresholds: LevelThreshold[] =
      rows.length > 0
        ? rows.map((r) => ({ level: r.level, cumulativeXp: Number(r.cumulativeXp) }))
        : buildThresholds(maxLevel, formula);
    return { policy, formula, thresholds };
  }

  /** Deterministic level for a total under the active policy. */
  levelForXp(totalXp: bigint, active: ActivePolicy): number {
    if (totalXp < 0n) throw new Error("totalXp must be >= 0");
    return levelFromXp(totalXp, active.thresholds);
  }

  /**
   * Lazy genesis (plan §10): a PID with no UserXpState row reads as L1/0 XP
   * and the row is created on first read — no ledger entry (sum over zero
   * rows is 0, so reconciliation is unaffected).
   */
  async ensureState(pid: string, active: ActivePolicy) {
    const existing = await this.prisma.userXpState.findUnique({ where: { pid } });
    if (existing) return existing;
    try {
      return await this.prisma.userXpState.create({
        data: { pid, totalXp: 0n, level: 1, policyVersionId: active.policy.id },
      });
    } catch (e) {
      // Lost the genesis race — the winner's row is the state.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        this.logger.debug(`UserXpState genesis race for ${pid}: using winner row`);
        return this.prisma.userXpState.findUniqueOrThrow({ where: { pid } });
      }
      throw e;
    }
  }

  /**
   * Full read path for GET /v1/users/{pid}/level and profile integration.
   * Throws NotFoundException for unknown or deleted identities (privacy:
   * levels are only readable for live ecosystem members).
   */
  async getLevelView(rawPid: string): Promise<LevelView> {
    const pid = rawPid.trim().toLowerCase();
    if (!isPid(pid)) throw new NotFoundException("Unknown user");
    const identity = await this.prisma.identity.findUnique({ where: { pid } });
    if (!identity || identity.status === "deleted") throw new NotFoundException("Unknown user");
    const active = await this.getActivePolicy();
    const state = await this.ensureState(pid, active);
    // Re-level hook (R4): if a newer policy was activated after this row was
    // stamped, the mapping recomputes lazily here. The stored level follows
    // on the next award (M3) or batched backfill — same re-level path.
    const level =
      state.policyVersionId === active.policy.id
        ? state.level
        : levelFromXp(state.totalXp, active.thresholds);
    const progress = progressFor(state.totalXp, level, active.thresholds);
    return {
      pid,
      level,
      total_xp: xpToJsonNumber(state.totalXp, "total_xp"),
      current_level_xp: progress.currentLevelXp,
      next_level_xp: progress.nextLevelXp,
      progress_percentage: progress.progressPercentage,
    };
  }
}
