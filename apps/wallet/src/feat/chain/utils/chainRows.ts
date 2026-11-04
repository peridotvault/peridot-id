import type { ApiError, ChainAccount } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * `POST /v1/account` is the documented per-chain row setup (GET only reads), so
 * a wallet provisioned before a chain gained its factory+implementation pair
 * gains that chain's deposit row only when this runs. Falls back to the read
 * when the write fails (throttle/offline) so last-known rows still render.
 */
export async function ensureChainRows(peridot: PeridotClient): Promise<ChainAccount[] | ApiError> {
  try {
    const ensured = await peridot.wallet.createAccount();
    if (ensured != null && typeof ensured === "object" && !("statusCode" in ensured)) return ensured;
  } catch {
    /* write failed — fall through to the read */
  }
  return peridot.wallet.me();
}
