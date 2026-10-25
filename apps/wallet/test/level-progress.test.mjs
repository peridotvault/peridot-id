// Level row math: the bar is band-relative, so the label must be too.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { progressWidth, xpProgressLabel } from "../src/feat/identity/utils/level.ts";

const summary = (over = {}) => ({
  pid: "ifal@pid",
  level: 2,
  total_xp: 450,
  current_level_xp: 100,
  next_level_xp: 900,
  progress_percentage: 43.75,
  ...over,
});

describe("xpProgressLabel", () => {
  it("reports XP inside the current band, not the lifetime total", () => {
    assert.equal(xpProgressLabel(summary()), "350 / 800 XP");
  });

  it("says Max level at the cap", () => {
    assert.equal(xpProgressLabel(summary({ next_level_xp: null, progress_percentage: 100 })), "Max level");
  });

  it("never goes negative if the stored level lags the total", () => {
    assert.equal(xpProgressLabel(summary({ total_xp: 50, current_level_xp: 100 })), "0 / 800 XP");
  });
});

describe("progressWidth", () => {
  it("rounds to a whole percent", () => {
    assert.equal(progressWidth(summary({ progress_percentage: 43.75 })), 44);
  });

  it("clamps out-of-range and non-numeric values", () => {
    assert.equal(progressWidth(summary({ progress_percentage: 140 })), 100);
    assert.equal(progressWidth(summary({ progress_percentage: -5 })), 0);
    assert.equal(progressWidth(summary({ progress_percentage: Number.NaN })), 0);
  });
});
