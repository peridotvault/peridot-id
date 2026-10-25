// Pre-approval fee gate for the Send review step (ANT-557, spec ANT-544 E-E2).
// Pure and UI-free so node:test can cover it (see test/fee-review.test.mjs);
// the FeePanel component renders these decisions, Send enforces them.
//
// Only SOL sends get a balance shortfall check: the smart-account SOL balance
// cannot cover token-amount shortfalls, and comparing across assets would be
// meaningless. The chain still enforces funds fail-closed at submit time.

import {
  coversBalance,
  ttlRemainingMs,
  type NormalizedFeeQuote,
} from "@peridotvault/pid-sdk-js";

export type FeeGateBlockReason = "expired" | "shortfall";

export type FeeGate = { ok: true } | { ok: false; reason: FeeGateBlockReason };

/**
 * Decide whether the quoted send may proceed to the passkey ceremony.
 * - Expired quote → block (user must fetch a fresh quote).
 * - SOL send whose balance < value + totalFee → block (top up first).
 * - Anything uncomputable (no balance/amount yet) → allow: display-only
 *   uncertainty must never block; the backend still enforces funds fail-closed.
 */
export function gateFeeApproval(input: {
  quote: NormalizedFeeQuote;
  asset: string;
  valueBaseUnits: string | null;
  balanceBaseUnits: string | null;
  nowMs: number;
}): FeeGate {
  if (ttlRemainingMs(input.quote, input.nowMs) <= 0) {
    return { ok: false, reason: "expired" };
  }
  if (input.asset === "SOL" && input.valueBaseUnits != null && input.balanceBaseUnits != null) {
    const covers = coversBalance(input.balanceBaseUnits, input.valueBaseUnits, input.quote.totalFee);
    if (covers === false) return { ok: false, reason: "shortfall" };
  }
  return { ok: true };
}
