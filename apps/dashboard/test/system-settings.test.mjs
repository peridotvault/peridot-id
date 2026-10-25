// ANT-460 — System Settings dashboard validation tests (pure logic only).
// Run: node --test test/system-settings.test.mjs
// These mirror apps/dashboard/src/settings/catalog.ts (client pre-validation;
// the server in ANT-459 is authoritative). The dashboard has no TS test
// runner; the build typechecks the real module. These cases pin the shapes
// both sides must satisfy (ANT-457 spec §3, §5).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Inline mirrors of apps/dashboard/src/settings/catalog.ts ---------------

const TASK_ID_FORMAT = /^[a-z0-9_]{1,64}$/;
const THRESHOLD_NAME_FORMAT = /^[a-z0-9_]{1,64}$/;
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

function lookupKind(key) {
  if (key === "xp.suspend.global") return "boolean";
  if (key === "xp.limits.daily" || key === "xp.limits.weekly" || key === "xp.limits.monthly") return "integer";
  if (key === "xp.policy.active") return "string";
  if (key === "xp.policy.thresholds" || key.startsWith("xp.rewards.") || key.startsWith("xp.app_permissions."))
    return "json";
  if (key.startsWith("xp.suspend.")) return "boolean";
  return null;
}

function validateReason(reason) {
  const len = reason.trim().length;
  if (len < MIN_REASON_LENGTH) return "too-short";
  if (len > MAX_REASON_LENGTH) return "too-long";
  return null;
}

function validateJson(key, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "Must be valid JSON.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "Must be a JSON object.";
  if (key.startsWith("xp.rewards.")) {
    if (typeof parsed.amount !== "number" || !Number.isInteger(parsed.amount) || parsed.amount < 0)
      return '"amount" must be an integer ≥ 0.';
    if (parsed.cap !== null && parsed.cap !== undefined) {
      if (typeof parsed.cap !== "number" || !Number.isInteger(parsed.cap) || parsed.cap < parsed.amount)
        return '"cap" must be null or an integer ≥ amount.';
    }
  }
  if (key.startsWith("xp.app_permissions.")) {
    if (typeof parsed.canEarn !== "boolean" || typeof parsed.canSpend !== "boolean")
      return '"canEarn" and "canSpend" must both be booleans.';
  }
  if (key === "xp.policy.thresholds") {
    const names = Object.keys(parsed);
    if (names.length > 50) return "At most 50 thresholds.";
    for (const name of names) {
      if (!THRESHOLD_NAME_FORMAT.test(name)) return `Invalid threshold name "${name}".`;
      if (typeof parsed[name] !== "number" || parsed[name] < 0) return `Threshold "${name}" must be a number ≥ 0.`;
    }
  }
  return null;
}

// --- Reason gate (spec §5, AC F-E2) ------------------------------------------

describe("reason gate", () => {
  it("rejects empty and short reasons", () => {
    assert.notEqual(validateReason(""), null);
    assert.notEqual(validateReason("fix it"), null);
    assert.notEqual(validateReason("  nine-chr "), null);
  });
  it("accepts a 10-char reason and trims padding", () => {
    assert.equal(validateReason("0123456789"), null);
    assert.equal(validateReason("  rollback bad deploy  "), null);
  });
  it("rejects over-long reasons", () => {
    assert.notEqual(validateReason("x".repeat(501)), null);
    assert.equal(validateReason("x".repeat(500)), null);
  });
});

// --- Per-key shapes (spec §3) -------------------------------------------------

describe("reward shape", () => {
  it("accepts amount with null cap", () => {
    assert.equal(validateJson("xp.rewards.quest_1", '{"amount": 50, "cap": null}'), null);
  });
  it("rejects negative amount and cap < amount", () => {
    assert.notEqual(validateJson("xp.rewards.quest_1", '{"amount": -1}'), null);
    assert.notEqual(validateJson("xp.rewards.quest_1", '{"amount": 50, "cap": 10}'), null);
  });
  it("rejects malformed JSON and non-objects", () => {
    assert.notEqual(validateJson("xp.rewards.quest_1", "{nope"), null);
    assert.notEqual(validateJson("xp.rewards.quest_1", "[1,2]"), null);
  });
});

describe("app permissions shape", () => {
  it("accepts both booleans, rejects missing/non-boolean", () => {
    assert.equal(validateJson("xp.app_permissions.app1", '{"canEarn": true, "canSpend": false}'), null);
    assert.notEqual(validateJson("xp.app_permissions.app1", '{"canEarn": true}'), null);
    assert.notEqual(validateJson("xp.app_permissions.app1", '{"canEarn": 1, "canSpend": 0}'), null);
  });
});

describe("thresholds shape", () => {
  it("accepts sane maps, rejects bad names/values/overflow", () => {
    assert.equal(validateJson("xp.policy.thresholds", '{"bronze": 100, "silver": 500}'), null);
    assert.equal(validateJson("xp.policy.thresholds", "{}"), null);
    assert.notEqual(validateJson("xp.policy.thresholds", '{"Bad Name!": 1}'), null);
    assert.notEqual(validateJson("xp.policy.thresholds", '{"bronze": -5}'), null);
    const big = `{${Array.from({ length: 51 }, (_, i) => `"t${i}": ${i}`).join(",")}}`;
    assert.notEqual(validateJson("xp.policy.thresholds", big), null);
  });
});

describe("key catalog", () => {
  it("resolves fixed keys to types", () => {
    assert.equal(lookupKind("xp.limits.daily"), "integer");
    assert.equal(lookupKind("xp.policy.active"), "string");
    assert.equal(lookupKind("xp.policy.thresholds"), "json");
  });
  it("resolves pattern keys, rejects unknown keys (closed catalog)", () => {
    assert.equal(lookupKind("xp.rewards.quest_1"), "json");
    assert.equal(lookupKind("xp.app_permissions.app1"), "json");
    assert.equal(lookupKind("xp.suspend.app1"), "boolean");
    assert.equal(lookupKind("xp.evil.newkey"), null);
  });
  it("task-id format pins the suffix rule", () => {
    assert.ok(TASK_ID_FORMAT.test("quest_1"));
    assert.ok(!TASK_ID_FORMAT.test("HAS SPACE"));
    assert.ok(!TASK_ID_FORMAT.test("x".repeat(65)));
  });
});
