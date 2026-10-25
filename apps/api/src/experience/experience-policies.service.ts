import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { ActivatePolicyDto, CreatePolicyDto, MaterializePolicyDto } from "./experience-admin.dto";
import { buildThresholds, DEFAULT_FORMULA, levelFromXp, type XpFormula } from "./xp-curve";
import { LevelsService } from "./levels.service";
import { checkGrantEnvelope, requireActiveAdmin } from "./experience-admin-guards";

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
function DEFAULT_FORMULA_MAX_LEVEL(): number {
  return 100;
}

@Injectable()
export class ExperiencePoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly levels: LevelsService,
    private readonly security: SecurityEventService,
  ) {}

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
    if (confirmedBy) await requireActiveAdmin(this.prisma, confirmedBy);
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
}
