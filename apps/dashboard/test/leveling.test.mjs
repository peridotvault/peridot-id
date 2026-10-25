// ANT-89 M2 — leveling dashboard helper tests (pure logic only).
// Run: node --test test/leveling.test.mjs
// These mirror the server-side contract: plan R5 reference values
// (L2=100, L5=1701, L10=11102, L25=118800, L100=3950079) and the
// backend catalog formats (catalog.ts EVENT_TYPE_FORMAT / MVP catalog).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Inline mirrors of apps/dashboard/src/leveling/xp.ts --------------------
// (Dashboard has no TS test runner; the build typechecks the real module.
// These cases pin the algorithm + reference values both sides must satisfy.)

function xpToAdvance(level, base = 100, exponent = 1.5) {
  return Math.floor(base * Math.pow(level, exponent));
}

function cumulativeXpForLevel(level, base = 100, exponent = 1.5) {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToAdvance(l, base, exponent);
  return total;
}

function formatXp(raw) {
  const s = typeof raw === "number" ? String(Math.trunc(raw)) : raw;
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).replace(/[^0-9]/g, "") || "0";
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const EVENT_TYPE_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;
const MVP_EVENT_TYPES = new Set([
  "onboarding_completed",
  "identity_verified",
  "campaign_completed",
  "achievement_earned",
  "ecosystem_activity",
]);

function validateEventType(value) {
  if (!EVENT_TYPE_FORMAT.test(value)) return "format";
  if (!MVP_EVENT_TYPES.has(value)) return "catalog";
  return null;
}

describe("formula (plan R5 reference)", () => {
  it("advances match the locked curve", () => {
    assert.equal(xpToAdvance(1), 100);
    assert.equal(xpToAdvance(2), 282);
  });

  it("cumulative thresholds match reference values", () => {
    assert.equal(cumulativeXpForLevel(1), 0);
    assert.equal(cumulativeXpForLevel(2), 100);
    assert.equal(cumulativeXpForLevel(5), 1701);
    assert.equal(cumulativeXpForLevel(10), 11102);
    assert.equal(cumulativeXpForLevel(25), 118800);
    assert.equal(cumulativeXpForLevel(100), 3950079);
  });
});

describe("formatXp (BigInt-string safe, no precision loss)", () => {
  it("groups thousands without Number conversion", () => {
    assert.equal(formatXp("3950079"), "3,950,079");
    assert.equal(formatXp("-1234567"), "-1,234,567");
    assert.equal(formatXp(100), "100");
    // Beyond MAX_SAFE_INTEGER — stays exact as a string.
    assert.equal(formatXp("9007199254740993"), "9,007,199,254,740,993");
  });
});

describe("event-type allowlist (C3 mirror)", () => {
  it("accepts every MVP catalog entry", () => {
    for (const t of MVP_EVENT_TYPES) assert.equal(validateEventType(t), null);
  });

  it("rejects bad format", () => {
    assert.notEqual(validateEventType("Bad-Name!"), null);
    assert.notEqual(validateEventType("ab"), null);
  });

  it("rejects unknown types that pass the format", () => {
    assert.equal(validateEventType("evil_grant"), "catalog");
  });
});
