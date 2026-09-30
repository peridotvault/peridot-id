import type { PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * Read-only provisioning check (no side effects, no DOKU calls). True when the
 * on-chain wallet record is missing. Anything unexpected → false (fail open to
 * home; login never traps). There is no fiat onboarding: the balance lives on
 * the internal ledger and is created lazily on the first paid deposit.
 */
export async function needsProvisioning(peridot: PeridotClient): Promise<boolean> {
  try {
    const acc = await peridot.wallet.me();
    if (typeof acc === "object" && acc !== null && "statusCode" in acc) return true;
  } catch {
    return false;
  }
  return false;
}
