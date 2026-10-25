// ANT-557: Send review-step gate — expiry and SOL shortfall block approval.
// Run: node --test "test/*.test.mjs" from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gateFeeApproval } from "../src/feat/chain/utils/feeReview.ts";
import { formatCountdown } from "../src/feat/chain/hooks/useQuoteCountdown.ts";

const QUOTE = {
  networkFee: "5000",
  platformFee: "17000",
  totalFee: "22000",
  maxTotalFee: "22000",
  feePolicyVersion: 2,
  chainTime: 1000,
  quotedAtMs: 1_000_000,
  expiresAtMs: 1_300_000,
  platformFeeDerived: false,
  maxTotalFeeDefaulted: false,
  raw: {},
};

describe("gateFeeApproval", () => {
  it("approves a live quote with covering balance", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "SOL", valueBaseUnits: "50000", balanceBaseUnits: "100000", nowMs: 1_100_000 }),
      { ok: true },
    );
  });

  it("blocks an expired quote even with covering balance", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "SOL", valueBaseUnits: "50000", balanceBaseUnits: "100000", nowMs: 1_300_000 }),
      { ok: false, reason: "expired" },
    );
  });

  it("blocks a SOL shortfall (balance < value + totalFee)", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "SOL", valueBaseUnits: "50000", balanceBaseUnits: "71999", nowMs: 1_100_000 }),
      { ok: false, reason: "shortfall" },
    );
  });

  it("passes exact-equality balance (value + total == balance)", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "SOL", valueBaseUnits: "50000", balanceBaseUnits: "72000", nowMs: 1_100_000 }),
      { ok: true },
    );
  });

  it("skips the shortfall check for token sends (SOL balance is not comparable)", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "USDC", valueBaseUnits: "1", balanceBaseUnits: "0", nowMs: 1_100_000 }),
      { ok: true },
    );
  });

  it("allows when balance is unknown (display-only uncertainty never blocks)", () => {
    assert.deepEqual(
      gateFeeApproval({ quote: QUOTE, asset: "SOL", valueBaseUnits: "50000", balanceBaseUnits: null, nowMs: 1_100_000 }),
      { ok: true },
    );
  });
});

describe("formatCountdown", () => {
  it("renders mm:ss, ceil seconds", () => {
    assert.equal(formatCountdown(252_000), "04:12");
    assert.equal(formatCountdown(1), "00:01");
  });
  it("renders expired at/below zero and — when unknown", () => {
    assert.equal(formatCountdown(0), "expired");
    assert.equal(formatCountdown(-5), "expired");
    assert.equal(formatCountdown(null), "—");
  });
});
