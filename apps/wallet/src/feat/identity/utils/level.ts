import type { LevelSummary } from "@peridotvault/pid-types";

/**
 * Level display helpers (ANT-89 M1 reads). `progress_percentage` is measured
 * inside the CURRENT level band, so the label must use band numbers too —
 * total/next would disagree with the bar.
 */

/** Clamp to 0..100: the API already rounds, but a bar must never overflow. */
export function progressWidth(level: LevelSummary): number {
  const v = Number(level.progress_percentage);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** "450 / 900 XP" inside the band, "Max level" at the cap. */
export function xpProgressLabel(level: LevelSummary): string {
  if (level.next_level_xp === null) return "Max level";
  const inLevel = Math.max(0, level.total_xp - level.current_level_xp);
  const band = Math.max(0, level.next_level_xp - level.current_level_xp);
  return `${inLevel.toLocaleString()} / ${band.toLocaleString()} XP`;
}
