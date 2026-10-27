// Lazy first-action helpers (ANT-731 WS4, spec WS1 §3 + §7).
//
// The wallet never shows a separate "activate" / "create account" step:
// the first send triggers account setup automatically inside the send flow.
// These units own that decision + copy. Pure and UI-free so node:test can
// cover them (see test/first-action.test.mjs).
//
// Backend state during WS2/WS3 rollout:
// - Lazy backend: the quote carries `activation.required === true` and the
//   submit succeeds in one user approval.
// - Pre-lazy backend: the submit fails with "Wallet must be activated before
//   sending". Send catches exactly that error, runs the passkey-signed setup
//   inline, and retries once — still one flow, no separate user step.

import type { NormalizedFeeQuote, PeridotClient } from "@peridotvault/pid-sdk-js";

/** Backend refusal when the smart account is not active yet (pre-lazy). */
export function isNotActivatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /must be activated before sending|account is not active|not yet activated/i.test(msg);
}

/**
 * True when this quote's intent triggers account creation. Reads ONLY the
 * server-computed envelope (WS1 §7.1) — the client never guesses from local
 * state. Unknown/absent envelope → false (normal send path).
 */
export function isFirstActionQuote(quote: NormalizedFeeQuote | null | undefined): boolean {
  return quote?.activation?.required === true;
}

/** Review-step notice: setup is included, no extra step, no "activate" CTA. */
export const FIRST_ACTION_REVIEW_NOTICE =
  "First send sets up your on-chain account automatically — the setup cost is included in the fee below. No extra step.";

/** Approve-button copy while the send also carries the first-time setup. */
export const FIRST_ACTION_APPROVE_TITLE = "Approve & set up";

/** Sending-phase status while the relayer processes send (+ setup). */
export const FIRST_ACTION_SENDING_COPY =
  "Setting up your on-chain account and sending — approve in your authenticator when asked.";

/** Progress copy while the inline setup runs after a pre-lazy refusal. */
export const SETUP_PROGRESS_COPY = "Setting up your on-chain account…";

/**
 * Ensure chain rows exist (idempotent) and passkey-activate the smart
 * account. Throws a user-facing Error — activation failures deduct nothing.
 */
export async function ensureAccountAndActivate(peridot: PeridotClient): Promise<void> {
  let acc = await peridot.wallet.me();
  if (acc != null && typeof acc === "object" && "statusCode" in acc) {
    acc = await peridot.wallet.createAccount();
  }
  if (acc != null && typeof acc === "object" && "statusCode" in acc) {
    throw new Error("Could not prepare your account — try again. Nothing was charged.");
  }
  const res = await peridot.wallet.activate();
  if (res != null && typeof res === "object" && "statusCode" in res) {
    const raw = (res as { message?: string | string[] }).message;
    const detail = Array.isArray(raw) ? raw.join(" ") : (raw ?? "Setup failed");
    throw new Error(`Account setup failed (${detail}) — your deposit stays in place. Retry from Send.`);
  }
}
