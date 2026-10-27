// Activation-view → FeePanel quote adapter (ANT-561, backend ANT-555; EVM ANT-736).
//
// Both activation views render through the same FeePanel path (AC-8):
// - SVM `ActivationView` carries legacy numeric lamports plus (on fee-policy
//   v2 backends) the canonical string envelope.
// - EVM `EvmActivationView` (ANT-730) carries Wei-suffixed legs plus the same
//   canonical aliases — `serviceFeeWei` and `platformFee` name the SAME value
//   (spec ANT-727 §4/7), so either feeds the normalizer.
//
// Returns a NormalizedFeeQuote when the view has v2 totals, else null — the
// parent then renders the legacy network-fee line (never a blended or
// invented total).
//
// EVM views carry no chain-time/expiry fields: the countdown anchor is the
// local clock at render (submit re-attests server-side, so this only bounds
// the display TTL — never the authorization).
//
// Pure and UI-free so node:test can cover it (see test/activation-fee.test.mjs).

import { normalizeFeeQuote, type EvmActivationView, type ActivationView, type NormalizedFeeQuote } from "@peridotvault/pid-sdk-js";

/** Activation views renderable as fee quotes (SVM + EVM share the FeePanel path). */
export type ActivationFeeView = ActivationView | EvmActivationView;

function isEvmView(view: ActivationFeeView): view is EvmActivationView {
  return "serviceFeeWei" in view || "chainReference" in view;
}

export function activationFeeQuote(view: ActivationFeeView): NormalizedFeeQuote | null {
  // Legacy v1 views quote no platform/total fee — nothing to normalize.
  if (view.totalFee == null && view.platformFee == null) return null;
  try {
    if (isEvmView(view)) {
      return normalizeFeeQuote({
        networkFee: view.networkFee ?? view.networkFeeWei,
        platformFee: view.platformFee ?? view.serviceFeeWei,
        serviceFeeWei: view.serviceFeeWei,
        totalFee: view.totalFee ?? view.totalFeeWei,
        maxTotalFee: view.maxTotalFee ?? view.maxTotalFeeWei,
        feePolicyVersion: view.feePolicyVersion,
        // EVM views carry no chain time — anchor the display TTL locally.
        chainTime: Math.floor(Date.now() / 1000),
        protocolFeeBps: view.protocolFeeBps,
        chainMinBaseUnits: view.chainMinBaseUnits,
      });
    }
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
