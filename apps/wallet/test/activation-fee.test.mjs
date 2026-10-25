// ANT-561: activation-view → FeePanel quote adapter.
// Run: node --test "test/*.test.mjs" from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activationFeeQuote } from "../src/feat/chain/utils/activationFee.ts";

const V2_VIEW = {
  status: "ready",
  smartAccountAddress: "So11111111111111111111111111111111111111112",
  balanceLamports: 1_000_000_000,
  requiredLamports: 500_000_000,
  networkFeeLamports: 5000,
  protocolFeeBps: 50,
  chainTime: 1_790_000_000,
  treasury: "Treasury1111111111111111111111111111111111111",
  feePolicyVersion: 2,
  networkFee: "5000",
  platformFee: "17000",
  totalFee: "22000",
  maxTotalFee: "22000",
  chainMinBaseUnits: "10000",
  quoteId: "q_sol_1",
  quotedAt: "2026-10-25T14:00:00.000Z",
  expiresAt: "2026-10-25T14:05:00.000Z",
};

describe("activationFeeQuote", () => {
  it("normalizes a v2 activation view into separate fee lines", () => {
    const q = activationFeeQuote(V2_VIEW);
    assert.ok(q);
    assert.equal(q.networkFee, "5000");
    assert.equal(q.platformFee, "17000");
    assert.equal(q.totalFee, "22000");
    assert.equal(q.maxTotalFee, "22000");
    assert.equal(q.feePolicyVersion, 2);
    assert.equal(q.platformFeeDerived, false);
    assert.equal(q.maxTotalFeeDefaulted, false);
    assert.equal(q.expiresAtMs, Date.parse("2026-10-25T14:05:00.000Z"));
  });

  it("derives the platform split when the view omits platformFee but has totalFee", () => {
    const { platformFee, ...rest } = V2_VIEW;
    const q = activationFeeQuote(rest);
    assert.ok(q);
    assert.equal(q.platformFee, "17000");
    assert.equal(q.platformFeeDerived, true);
  });

  it("returns null for legacy v1 views (no invented totals)", () => {
    const { networkFee, platformFee, totalFee, maxTotalFee, ...legacy } = V2_VIEW;
    assert.equal(activationFeeQuote(legacy), null);
  });

  it("returns null for inconsistent views (total < network)", () => {
    assert.equal(activationFeeQuote({ ...V2_VIEW, totalFee: "1000" }), null);
  });

  it("returns null for non-numeric amounts", () => {
    assert.equal(activationFeeQuote({ ...V2_VIEW, networkFee: "lots" }), null);
  });
});
