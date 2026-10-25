// ANT-557: fee-quote normalization, formatting, TTL math, failure taxonomy.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
// (also picked up by `node --test test/fee-quote.test.mjs`)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZATION_TTL_SECS,
  FeeApprovalDeniedError,
  QUOTE_TTL_SECS,
  classifyFeeFailure,
  coversBalance,
  formatFeeAmount,
  normalizeFeeQuote,
  shortfallBaseUnits,
  shortfallMessage,
  ttlRemainingMs,
} from "../dist/esm/index.js";

const V2 = {
  networkFee: "5000",
  platformFee: "17000",
  feePolicyVersion: 2,
  totalFee: "22000",
  maxTotalFee: "22000",
  chainTime: 1_790_000_000,
  quoteId: "q_sol_1",
  quotedAt: "2026-10-25T14:00:00.000Z",
  expiresAt: "2026-10-25T14:05:00.000Z",
};

test("normalizeFeeQuote: canonical v2 shape passes through resolved", () => {
  const q = normalizeFeeQuote({ ...V2 });
  assert.equal(q.networkFee, "5000");
  assert.equal(q.platformFee, "17000");
  assert.equal(q.totalFee, "22000");
  assert.equal(q.maxTotalFee, "22000");
  assert.equal(q.feePolicyVersion, 2);
  assert.equal(q.platformFeeDerived, false);
  assert.equal(q.maxTotalFeeDefaulted, false);
  assert.equal(q.expiresAtMs, Date.parse("2026-10-25T14:05:00.000Z"));
});

test("normalizeFeeQuote: worked example — Solana floor-wins (spec B3)", () => {
  // network 0.000005 SOL (5000 lamports) → platform floor 17000 → total 22000.
  const q = normalizeFeeQuote({
    networkFee: "5000",
    platformFee: "17000",
    feePolicyVersion: 1,
    totalFee: "22000",
    maxTotalFee: "22000",
    chainTime: 100,
  });
  assert.equal(q.totalFee, "22000");
});

test("normalizeFeeQuote: legacy v1 shape derives the platform split (never blended-only)", () => {
  const q = normalizeFeeQuote({
    networkFeeLamports: "5000",
    totalFeeLamports: "22000",
    feePolicyVersion: 1,
    chainTime: 100,
  });
  assert.equal(q.networkFee, "5000");
  assert.equal(q.platformFee, "17000");
  assert.equal(q.totalFee, "22000");
  assert.equal(q.maxTotalFee, "22000");
  assert.equal(q.platformFeeDerived, true);
  assert.equal(q.maxTotalFeeDefaulted, true);
});

test("normalizeFeeQuote: maxTotalFee above total is preserved (drift headroom)", () => {
  const q = normalizeFeeQuote({ ...V2, maxTotalFee: "30000", suggestedMaxTotalFee: "30000" });
  assert.equal(q.maxTotalFee, "30000");
  assert.equal(q.maxTotalFeeDefaulted, false);
});

test("normalizeFeeQuote: fail-closed on missing/inconsistent amounts", () => {
  assert.throws(() => normalizeFeeQuote({ ...V2, networkFee: undefined, networkFeeLamports: undefined }), /networkFee/);
  assert.throws(() => normalizeFeeQuote({ ...V2, totalFee: "1" }), /totalFee/);
  assert.throws(() => normalizeFeeQuote({ ...V2, maxTotalFee: "1" }), /maxTotalFee/);
  assert.throws(() => normalizeFeeQuote({ ...V2, feePolicyVersion: 0 }), /feePolicyVersion/);
  assert.throws(
    () => normalizeFeeQuote({ networkFeeLamports: "5000", feePolicyVersion: 1, chainTime: 1 }),
    /platformFee and totalFee/,
  );
});

test("normalizeFeeQuote: expiry falls back to quotedAt + TTL, then chainTime + TTL", () => {
  const noExpiry = normalizeFeeQuote({ ...V2, expiresAt: undefined });
  assert.equal(noExpiry.expiresAtMs, Date.parse("2026-10-25T14:00:00.000Z") + QUOTE_TTL_SECS * 1000);
  const bare = normalizeFeeQuote({
    networkFee: "1",
    platformFee: "2",
    feePolicyVersion: 1,
    totalFee: "3",
    maxTotalFee: "3",
    chainTime: 1000,
  });
  assert.equal(bare.expiresAtMs, 1000 * 1000 + QUOTE_TTL_SECS * 1000);
  assert.equal(QUOTE_TTL_SECS, 300);
  assert.equal(AUTHORIZATION_TTL_SECS, 600);
});

test("formatFeeAmount: lamports to SOL, integer math, trimmed", () => {
  assert.equal(formatFeeAmount("5000", 9, "SOL"), "0.000005 SOL");
  assert.equal(formatFeeAmount("17000", 9, "SOL"), "0.000017 SOL");
  assert.equal(formatFeeAmount("22000", 9, "SOL"), "0.000022 SOL");
  assert.equal(formatFeeAmount("1000000000", 9, "SOL"), "1 SOL");
  assert.equal(formatFeeAmount("0", 9, "SOL"), "0 SOL");
  assert.throws(() => formatFeeAmount("1.5", 9, "SOL"), /integer/);
});

test("ttlRemainingMs: positive before expiry, non-positive after", () => {
  const q = normalizeFeeQuote({ ...V2 });
  assert.ok(ttlRemainingMs(q, Date.parse("2026-10-25T14:04:00.000Z")) > 0);
  assert.ok(ttlRemainingMs(q, Date.parse("2026-10-25T14:05:00.000Z")) <= 0);
});

test("coversBalance / shortfallBaseUnits: balance vs value + totalFee", () => {
  assert.equal(coversBalance("100000", "50000", "22000"), true);
  assert.equal(coversBalance("71999", "50000", "22000"), false);
  assert.equal(coversBalance("72000", "50000", "22000"), true); // exact equality passes
  assert.equal(shortfallBaseUnits("71999", "50000", "22000"), "1");
  assert.equal(shortfallBaseUnits("100000", "50000", "22000"), "0");
  assert.equal(coversBalance("abc", "50000", "22000"), null);
});

test("shortfallMessage: names balance vs needed with the shortfall", () => {
  const msg = shortfallMessage({
    balanceBaseUnits: "10000",
    valueBaseUnits: "50000",
    totalFeeBaseUnits: "22000",
    decimals: 9,
    symbol: "SOL",
  });
  assert.match(msg, /0\.00001 SOL/); // balance
  assert.match(msg, /0\.000072 SOL/); // needed = 50000 + 22000
  assert.match(msg, /short by 0\.000062 SOL/);
});

test("classifyFeeFailure: every taxonomy class maps to its fixed prompt", () => {
  assert.equal(classifyFeeFailure(new Error("stale nonce 5, expected 6")).code, "STALE_NONCE");
  assert.equal(classifyFeeFailure(new Error("Stale nonce")).action, "re-sign");
  assert.equal(classifyFeeFailure(new Error("Authorization expired — please try again")).code, "AUTHORIZATION_EXPIRED");
  assert.equal(classifyFeeFailure(new Error("Network fee moved — re-quote and try again")).code, "FEE_DRIFT");
  assert.equal(classifyFeeFailure(new Error("Network fee moved — re-quote and try again")).action, "re-quote");
  assert.equal(
    classifyFeeFailure(new Error("Total fee exceeds your authorized maximum — re-quote and try again")).code,
    "MAX_TOTAL_EXCEEDED",
  );
  assert.equal(
    classifyFeeFailure(new Error("Insufficient SOL for fee — need 100, have 10")).code,
    "INSUFFICIENT_FUNDS",
  );
  assert.equal(classifyFeeFailure(new Error("Insufficient balance — need 1, have 0")).action, "top-up");
  assert.equal(classifyFeeFailure(new Error("Unsupported fee policy — re-quote and try again")).code, "POLICY_VIOLATION");
  assert.equal(classifyFeeFailure(new Error("Unsupported fee policy — re-quote and try again")).action, "fail-closed");
  assert.equal(classifyFeeFailure(new Error("Authorization lifetime exceeds 600 seconds")).code, "POLICY_VIOLATION");
  assert.equal(classifyFeeFailure(new FeeApprovalDeniedError()).code, "APPROVAL_DENIED");
  const unknown = classifyFeeFailure(new Error("boom"));
  assert.equal(unknown.code, "UNKNOWN");
  assert.match(unknown.body, /boom/);
});

test("classifyFeeFailure: policy copy never advises retry-with-same-payload", () => {
  const body = classifyFeeFailure(new Error("Unsupported fee policy — re-quote and try again")).body;
  assert.match(body, /don't retry with the same details/);
});
