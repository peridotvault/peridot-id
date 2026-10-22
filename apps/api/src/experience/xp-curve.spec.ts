import {
  DEFAULT_FORMULA,
  buildThresholds,
  cumulativeXpForLevel,
  levelFromXp,
  progressFor,
  xpToAdvance,
} from "./xp-curve";

// ANT-89 M1 acceptance: exact L1–100 curve test (plan §3 simulation reference).
describe("xp-curve (authoritative leveling math)", () => {
  it("xpToAdvance(L) = floor(100 * L^1.5)", () => {
    expect(xpToAdvance(1)).toBe(100);
    expect(xpToAdvance(2)).toBe(282);
    expect(xpToAdvance(3)).toBe(519);
    expect(xpToAdvance(5)).toBe(1118);
    expect(xpToAdvance(10)).toBe(3162);
    expect(xpToAdvance(25)).toBe(12500);
    expect(xpToAdvance(100)).toBe(100000);
  });

  it("matches the plan §3 reference cumulative values exactly", () => {
    expect(cumulativeXpForLevel(1)).toBe(0);
    expect(cumulativeXpForLevel(2)).toBe(100);
    expect(cumulativeXpForLevel(5)).toBe(1701);
    expect(cumulativeXpForLevel(10)).toBe(11102);
    expect(cumulativeXpForLevel(25)).toBe(118800);
    expect(cumulativeXpForLevel(50)).toBe(689494);
    expect(cumulativeXpForLevel(75)).toBe(1916154);
    expect(cumulativeXpForLevel(100)).toBe(3950079);
  });

  it("marginal cost is strictly increasing across all 100 levels", () => {
    const advs = Array.from({ length: 100 }, (_, i) => xpToAdvance(i + 1));
    for (let i = 1; i < advs.length; i++) expect(advs[i]).toBeGreaterThan(advs[i - 1]);
  });

  it("levelFromXp is deterministic with exact band edges", () => {
    const t = buildThresholds(100, DEFAULT_FORMULA);
    expect(levelFromXp(0, t)).toBe(1);
    expect(levelFromXp(99, t)).toBe(1);
    expect(levelFromXp(100, t)).toBe(2);
    expect(levelFromXp(381, t)).toBe(2);
    expect(levelFromXp(382, t)).toBe(3);
    expect(levelFromXp(1701, t)).toBe(5);
    expect(levelFromXp(3950079, t)).toBe(100);
    // Past the cap stays at maxLevel (bigint input included).
    expect(levelFromXp(99999999, t)).toBe(100);
    expect(levelFromXp(1701n, t)).toBe(5);
  });

  it("progressFor reports band position; cap has null next_level_xp", () => {
    const t = buildThresholds(100, DEFAULT_FORMULA);
    const mid = progressFor(50, 1, t);
    expect(mid).toEqual({ level: 1, currentLevelXp: 0, nextLevelXp: 100, progressPercentage: 50 });
    const edge = progressFor(100, 2, t);
    expect(edge.currentLevelXp).toBe(100);
    expect(edge.nextLevelXp).toBe(382);
    const cap = progressFor(99999999, 100, t);
    expect(cap.nextLevelXp).toBeNull();
    expect(cap.progressPercentage).toBe(100);
  });

  it("per-level overrides replace formula rows (preview path)", () => {
    const t = buildThresholds(100, DEFAULT_FORMULA, new Map([[2, 50]]));
    expect(t[1]).toEqual({ level: 2, cumulativeXp: 50 });
    expect(levelFromXp(50, t)).toBe(2);
    expect(levelFromXp(49, t)).toBe(1);
    // Untouched bands keep formula values.
    expect(t[4]).toEqual({ level: 5, cumulativeXp: 1701 });
  });

  it("non-monotonic overrides are rejected (level mapping must stay total)", () => {
    expect(() => buildThresholds(5, DEFAULT_FORMULA, new Map([[3, 10]]))).toThrow(/monotonicity/);
  });

  it("rejects invalid inputs at the boundary", () => {
    expect(() => xpToAdvance(0)).toThrow();
    expect(() => cumulativeXpForLevel(-3)).toThrow();
    expect(() => buildThresholds(0)).toThrow();
    expect(() => levelFromXp(-1, buildThresholds(3))).toThrow();
  });
});
