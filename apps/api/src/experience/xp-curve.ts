/**
 * ANT-89 M1 — authoritative XP→Level mathematics (server-only).
 *
 * Default formula (plan R5, locked): xpToAdvance(L) = floor(base * L^exponent)
 * with base=100, exponent=1.5. Pure functions: no DB, no clock, fully
 * deterministic — the same total XP always maps to the same level.
 *
 * Cumulative threshold for level L = Σ_{i<L} xpToAdvance(i) (L1 = 0).
 * Simulated reference (plan §3): L2=100, L5=1701, L10=11102, L25=118800,
 * L50=689494, L75=1916154, L100=3950079.
 */

export interface XpFormula {
  base: number;
  exponent: number;
  rounding: "floor";
}

export const DEFAULT_FORMULA: XpFormula = { base: 100, exponent: 1.5, rounding: "floor" };
export const DEFAULT_MAX_LEVEL = 100;

/** XP required to advance FROM level L TO level L+1. */
export function xpToAdvance(level: number, formula: XpFormula = DEFAULT_FORMULA): number {
  if (!Number.isInteger(level) || level < 1) throw new Error(`Invalid level: ${level}`);
  return Math.floor(formula.base * Math.pow(level, formula.exponent));
}

/** Total XP required to REACH `level` (level 1 = 0). */
export function cumulativeXpForLevel(level: number, formula: XpFormula = DEFAULT_FORMULA): number {
  if (!Number.isInteger(level) || level < 1) throw new Error(`Invalid level: ${level}`);
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToAdvance(l, formula);
  return total;
}

export interface LevelThreshold {
  level: number;
  cumulativeXp: number;
}

/**
 * Materialize thresholds for levels 1..maxLevel (seeded per policy version;
 * per-level overrides replace rows afterwards — overrides win over formula).
 */
export function buildThresholds(
  maxLevel: number,
  formula: XpFormula = DEFAULT_FORMULA,
  overrides: Map<number, number> = new Map(),
): LevelThreshold[] {
  if (!Number.isInteger(maxLevel) || maxLevel < 1) throw new Error(`Invalid maxLevel: ${maxLevel}`);
  const rows: LevelThreshold[] = [];
  for (let level = 1; level <= maxLevel; level++) {
    const override = overrides.get(level);
    rows.push({ level, cumulativeXp: override ?? cumulativeXpForLevel(level, formula) });
  }
  // Overrides must keep the curve non-decreasing, else level-from-XP is ambiguous.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].cumulativeXp < rows[i - 1].cumulativeXp) {
      throw new Error(`Threshold override breaks monotonicity at level ${rows[i].level}`);
    }
  }
  return rows;
}

/**
 * Deterministic level-from-XP: the highest level whose threshold is met,
 * capped at the highest materialized level (maxLevel).
 */
export function levelFromXp(totalXp: number | bigint, thresholds: LevelThreshold[]): number {
  const xp = typeof totalXp === "bigint" ? totalXp : BigInt(Math.floor(totalXp));
  if (xp < 0n) throw new Error(`Invalid totalXp: ${totalXp}`);
  let level = 1;
  for (const row of thresholds) {
    if (xp >= BigInt(row.cumulativeXp)) level = row.level;
    else break;
  }
  return level;
}

export interface LevelProgress {
  level: number;
  /** XP marking the start of the current level. */
  currentLevelXp: number;
  /** XP marking the next level, or null at the cap. */
  nextLevelXp: number | null;
  /** 0–100, rounded to 2 decimals; 100 at the cap. */
  progressPercentage: number;
}

/** Progress of `totalXp` within its level band. */
export function progressFor(totalXp: number | bigint, level: number, thresholds: LevelThreshold[]): LevelProgress {
  const xp = Number(typeof totalXp === "bigint" ? totalXp : Math.floor(totalXp));
  const byLevel = new Map(thresholds.map((t) => [t.level, t.cumulativeXp]));
  const currentLevelXp = byLevel.get(level) ?? 0;
  const next = byLevel.get(level + 1) ?? null;
  if (next === null) return { level, currentLevelXp, nextLevelXp: null, progressPercentage: 100 };
  const span = next - currentLevelXp;
  const pct = span <= 0 ? 100 : Math.min(100, Math.max(0, ((xp - currentLevelXp) / span) * 100));
  return { level, currentLevelXp, nextLevelXp: next, progressPercentage: Math.round(pct * 100) / 100 };
}

/** Assert a bigint XP total fits in a JSON-safe number (documents the wire invariant). */
export function xpToJsonNumber(value: bigint, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`XP total out of JSON-safe range (${field})`);
  return n;
}
