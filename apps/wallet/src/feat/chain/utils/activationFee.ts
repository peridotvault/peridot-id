// Activation-view → FeePanel quote adapter (ANT-561, backend ANT-555).
//
// The activation view carries legacy numeric lamports plus (on fee-policy v2
// backends) the canonical string envelope. Returns a NormalizedFeeQuote when
// the view has v2 totals, else null — the parent then renders the legacy
// network-fee line (never a blended or invented total).
//
// Pure and UI-free so node:test can cover it (see test/activation-fee.test.mjs).

import { normalizeFeeQuote, type ActivationView, type NormalizedFeeQuote } from "@peridotvault/pid-sdk-js";

export function activationFeeQuote(view: ActivationView): NormalizedFeeQuote | null {
  // Legacy v1 views quote no platform/total fee — nothing to normalize.
  if (view.totalFee == null && view.platformFee == null) return null;
  try {
    return normalizeFeeQuote({
      networkFee: view.networkFee ?? String(view.networkFeeLamports),
      platformFee: view.platformFee,
      totalFee: view.totalFee,
      maxTotalFee: view.maxTotalFee,
      feePolicyVersion: view.feePolicyVersion,
      chainTime: view.chainTime,
      protocolFeeBps: view.protocolFeeBps,
      treasury: view.treasury,
      quoteId: view.quoteId,
      quotedAt: view.quotedAt,
      expiresAt: view.expiresAt,
      chain: view.chain,
      chainMinBaseUnits: view.chainMinBaseUnits,
    });
  } catch {
    // Inconsistent v2 view (fail-closed normalizer) → legacy line, never a guess.
    return null;
  }
}
