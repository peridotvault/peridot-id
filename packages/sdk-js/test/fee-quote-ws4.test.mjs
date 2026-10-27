// ANT-736 (WS4, backend ANT-730): EVM fee aliases + typed sad-path codes.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
// (also picked up by `node --test test/fee-quote-ws4.test.mjs`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFeeFailure, normalizeFeeQuote } from "../dist/esm/index.js";

const EVM = {
  networkFeeWei: "1000000000000000",
  serviceFeeWei: "2000000000000000",
  networkFee: "1000000000000000",
  platformFee: "2000000000000000",
  totalFee: "3000000000000000",
  maxTotalFee: "3000000000000000",
  totalFeeWei: "3000000000000000",
  maxTotalFeeWei: "3000000000000000",
  feePolicyVersion: 2,
  chainTime: 1_790_000_000,
  protocolFeeBps: 50,
  chainMinBaseUnits: "1000000000000000",
  quotedAt: "2026-10-25T14:00:00.000Z",
  expiresAt: "2026-10-25T14:05:00.000Z",
};

test("normalizeFeeQuote: EVM Wei-suffixed legs resolve to the canonical lines", () => {
  const q = normalizeFeeQuote({ ...EVM });
  assert.equal(q.networkFee, "1000000000000000");
  assert.equal(q.platformFee, "2000000000000000");
  assert.equal(q.totalFee, "3000000000000000");
  assert.equal(q.maxTotalFee, "3000000000000000");
  assert.equal(q.platformFeeDerived, false);
});

test("normalizeFeeQuote: serviceFeeWei alone names the platform leg (same value)", () => {
  const { platformFee, ...rest } = EVM;
  void platformFee;
  const q = normalizeFeeQuote({ ...rest });
  assert.equal(q.platformFee, "2000000000000000");
  assert.equal(q.totalFee, "3000000000000000");
});

test("normalizeFeeQuote: bare serviceFee / protocolFee aliases name the platform leg", () => {
  const base = {
    networkFee: "5000",
    totalFee: "22000",
    maxTotalFee: "22000",
    feePolicyVersion: 2,
    chainTime: 100,
  };
  assert.equal(normalizeFeeQuote({ ...base, serviceFee: "17000" }).platformFee, "17000");
  assert.equal(normalizeFeeQuote({ ...base, protocolFee: "17000" }).platformFee, "17000");
});

test("classifyFeeFailure: StaleQuote (410) re-quotes", () => {
  for (const msg of ["StaleQuote: superseded", "Fee policy superseded — re-quote and try again", "stale quote"]) {
    const f = classifyFeeFailure(new Error(msg));
    assert.equal(f.code, "STALE_QUOTE", msg);
    assert.equal(f.action, "re-quote", msg);
  }
});

test("classifyFeeFailure: FeeExceedsMax (409) re-quotes with raise-the-max copy", () => {
  const f = classifyFeeFailure(new Error("FeeExceedsMax: totalFee exceeds maxTotalFee"));
  assert.equal(f.code, "MAX_TOTAL_EXCEEDED");
  assert.equal(f.action, "re-quote");
  assert.match(f.body, /Raise the authorized max/i);
});

test("classifyFeeFailure: ChainMinBelowFloor (400) fails closed as admin setup", () => {
  const f = classifyFeeFailure(new Error("ChainMinBelowFloor: minimum below settlement floor"));
  assert.equal(f.code, "CHAIN_MIN_BELOW_FLOOR");
  assert.equal(f.action, "fail-closed");
});

test("classifyFeeFailure: ActivationInProgress (409) polls the same firstActionId", () => {
  const f = classifyFeeFailure(new Error("ActivationInProgress: same firstActionId, poll for status"));
  assert.equal(f.code, "ACTIVATION_IN_PROGRESS");
  assert.equal(f.action, "poll");
  assert.match(f.body, /already being processed/i);
});

test("classifyFeeFailure: existing codes unchanged", () => {
  assert.equal(classifyFeeFailure(new Error("nothing was signed")).code, "APPROVAL_DENIED");
  assert.equal(classifyFeeFailure(new Error("Unsupported fee policy")).code, "POLICY_VIOLATION");
  assert.equal(classifyFeeFailure(new Error("totally novel failure")).code, "UNKNOWN");
});
