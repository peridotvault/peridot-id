// ANT-731 (WS4, spec WS1 §7.1): lazy first-action `activation` envelope on
// fee quotes — passthrough when well-formed, undefined otherwise.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
// (also picked up by `node --test test/fee-quote-activation.test.mjs`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFeeQuote } from "../dist/esm/index.js";

const V2 = {
  networkFee: "5000",
  platformFee: "17000",
  feePolicyVersion: 2,
  totalFee: "22000",
  maxTotalFee: "22000",
  chainTime: 1_790_000_000,
};

const ACTIVATION = {
  required: true,
  includedInTotal: true,
  estimate: "350000",
  estimateBasis: "DEPLOY_GAS_ESTIMATE[97]=350000 x gasPrice=1gwei",
  mode: "svm-composite",
};

test("normalizeFeeQuote: well-formed activation envelope passes through verbatim", () => {
  const q = normalizeFeeQuote({ ...V2, activation: { ...ACTIVATION } });
  assert.deepEqual(q.activation, { ...ACTIVATION });
});

test("normalizeFeeQuote: mode none + required false passes through (already active)", () => {
  const q = normalizeFeeQuote({
    ...V2,
    activation: { required: false, includedInTotal: true, estimate: "0", mode: "none" },
  });
  assert.deepEqual(q.activation, { required: false, includedInTotal: true, estimate: "0", mode: "none" });
});

test("normalizeFeeQuote: missing envelope stays undefined (pre-lazy backend)", () => {
  const q = normalizeFeeQuote({ ...V2 });
  assert.equal(q.activation, undefined);
});

test("normalizeFeeQuote: malformed envelope is dropped, never half-parsed", () => {
  for (const bad of [
    { required: "yes", includedInTotal: true, estimate: "1", mode: "none" },
    { required: true, includedInTotal: true, estimate: "-5", mode: "none" },
    { required: true, includedInTotal: true, estimate: "1", mode: "teleport" },
    { required: true, includedInTotal: true, estimate: "1", mode: "none", estimateBasis: 42 },
    "required",
    42,
  ]) {
    const q = normalizeFeeQuote({ ...V2, activation: bad });
    assert.equal(q.activation, undefined, JSON.stringify(bad));
  }
});
