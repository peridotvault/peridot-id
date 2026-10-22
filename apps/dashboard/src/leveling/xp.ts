/**
 * ANT-89 M2 — leveling dashboard helpers (client-side mirrors only).
 *
 * The server is authoritative for every number here: thresholds come from
 * `GET /v1/admin/experience/policies` + preview, awards/quotas are enforced
 * in Prisma transactions. These mirrors exist ONLY for the Levels simulator
 * preview and for client-side input hints — never for awarding XP.
 *
 * Formula locked per plan R5: xpToAdvance(L) = floor(100 * L^1.5).
 * Reference: L2=100, L5=1701, L10=11102, L25=118800, L100=3950079.
 */

export const FORMULA_BASE = 100;
export const FORMULA_EXPONENT = 1.5;
export const DEFAULT_MAX_LEVEL = 100;

/** MVP event-type catalog (mirrors apps/api/.../experience/catalog.ts). */
export const MVP_EVENT_TYPES = [
  "onboarding_completed",
  "identity_verified",
  "campaign_completed",
  "achievement_earned",
  "ecosystem_activity",
] as const;

/** Reliable checker registry (mirrors catalog.ts RELIABLE_CHECKERS). */
export const RELIABLE_CHECKERS = [
  "internal_state.onboarding_completed",
  "internal_state.identity_verified",
  "internal_state.campaign_verified",
  "backend_check.achievement_owned",
  "backend_check.activity_verified",
] as const;

export const EVENT_TYPE_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;
export const TASK_KEY_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;
export const TASK_RECURRING = ["once", "daily", "weekly", "monthly", "unlimited"] as const;
export const TASK_STATUSES = ["draft", "active", "disabled", "archived"] as const;
export const LEDGER_KINDS = ["task_award", "manual_adjustment", "reversal"] as const;

/** Second-person envelope floor (mirrors SECOND_PERSON_MIN_REASON). */
export const MIN_JUSTIFICATION = 10;

/** XP required to advance FROM level L TO level L+1. */
export function xpToAdvance(level: number, base = FORMULA_BASE, exponent = FORMULA_EXPONENT): number {
  if (!Number.isInteger(level) || level < 1) throw new Error(`Invalid level: ${level}`);
  return Math.floor(base * Math.pow(level, exponent));
}

/** Total XP required to REACH `level` (level 1 = 0 XP). */
export function cumulativeXpForLevel(level: number, base = FORMULA_BASE, exponent = FORMULA_EXPONENT): number {
  if (!Number.isInteger(level) || level < 1) throw new Error(`Invalid level: ${level}`);
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToAdvance(l, base, exponent);
  return total;
}

export interface ThresholdRow {
  level: number;
  cumulativeXp: number;
}

/** Materialize the formula curve for 1..maxLevel (overrides win, must stay non-decreasing). */
export function buildThresholds(
  maxLevel: number,
  base = FORMULA_BASE,
  exponent = FORMULA_EXPONENT,
  overrides: Map<number, number> = new Map(),
): ThresholdRow[] {
  if (!Number.isInteger(maxLevel) || maxLevel < 1) throw new Error(`Invalid maxLevel: ${maxLevel}`);
  const rows: ThresholdRow[] = [];
  for (let level = 1; level <= maxLevel; level++) {
    rows.push({ level, cumulativeXp: overrides.get(level) ?? cumulativeXpForLevel(level, base, exponent) });
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].cumulativeXp < rows[i - 1].cumulativeXp) {
      throw new Error(`Threshold override breaks monotonicity at level ${rows[i].level}`);
    }
  }
  return rows;
}

/** Level attained for a total XP under the given thresholds. */
export function levelFromXp(totalXp: number, thresholds: ThresholdRow[]): number {
  let level = 1;
  for (const t of thresholds) {
    if (totalXp >= t.cumulativeXp) level = t.level;
    else break;
  }
  return level;
}

/** Client-side event-type hint: format first, then catalog membership. */
export function validateEventType(value: string): string | null {
  if (!EVENT_TYPE_FORMAT.test(value)) return `must match ^[a-z][a-z0-9_]{2,63}$`;
  if (!(MVP_EVENT_TYPES as readonly string[]).includes(value)) return `not in the MVP catalog`;
  return null;
}

/** Group a (possibly BigInt-string) integer with thousands separators without precision loss. */
export function formatXp(raw: number | string): string {
  const s = typeof raw === "number" ? String(Math.trunc(raw)) : raw;
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).replace(/[^0-9]/g, "") || "0";
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** F3 envelope status for a raise/grant form (client hint; server re-checks). */
export function grantEnvelopeStatus(input: {
  isRaise: boolean;
  confirmedBy?: string;
  reason?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!input.isRaise) return { ok: true };
  const confirmedBy = (input.confirmedBy ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (confirmedBy) return { ok: true };
  if (reason.length >= MIN_JUSTIFICATION) return { ok: true };
  return {
    ok: false,
    error: `Raises need a second-person confirm (confirmedBy) or a justification ≥ ${MIN_JUSTIFICATION} chars`,
  };
}
