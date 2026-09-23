import type { PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * Shared fiat onboarding path (stepper + inline fallbacks).
 * Registration is idempotent server-side, so ensuring is safe to re-run.
 */

/**
 * Resolve the pid + login email used for Sub-Account registration.
 * The DOKU-side account name is ALWAYS the pid (e.g. `ifal@pid`) — never
 * the display name — so the dashboard shows ecosystem identities, and one
 * user can't grab another's label. The in-app display name is unaffected.
 */
export async function resolveFiatIdentity(peridot: PeridotClient): Promise<{ name: string; email: string }> {
  let pid: string | null = null;
  let email: string | null = null;
  try {
    const me = await peridot.identity.me();
    if (me && !("statusCode" in me)) pid = String((me as { pid: string }).pid) || null;
  } catch {
    // best-effort — surfaced below when missing
  }
  try {
    const list = await peridot.identity.credentials();
    email = (Array.isArray(list) ? (list as { email?: string | null }[]) : []).map((c) => c.email).find((e) => !!e) ?? null;
  } catch {
    // best-effort — surfaced as a friendly error below
  }
  if (!pid) throw new Error("No identity found — please sign in again.");
  if (!email) throw new Error("No login email found — sign in with Google first.");
  return { name: pid, email };
}

/**
 * Read-only provisioning check (no side effects, no DOKU calls — both reads
 * hit our own API/DB). True when the wallet record or the usable Sub-Account
 * (profileId present) is missing. Anything unexpected → false (fail open to
 * home; the screens' ensure-fallbacks heal later, and login never traps).
 */
export async function needsProvisioning(peridot: PeridotClient): Promise<boolean> {
  try {
    const acc = await peridot.wallet.me();
    if (typeof acc === "object" && acc !== null && "statusCode" in acc) return true;
  } catch {
    return false;
  }
  try {
    const existing = await peridot.fiat.account();
    if (!existing?.profileId) return true;
  } catch (e) {
    if (/not registered/i.test(String(e))) return true;
    return false;
  }
  return false;
}

/**
 * Ensure the caller's DOKU Sub-Account exists AND is usable (profileId
 * present). A row stuck in `creating`/`failed` without a profileId is NOT
 * success — fall through to (re-)register; the server guards true
 * concurrency with 409 and recovers dead rows. Safe to re-run.
 */
export async function ensureSubAccount(peridot: PeridotClient): Promise<void> {
  try {
    const existing = await peridot.fiat.account();
    if (existing?.profileId) return;
  } catch (e) {
    if (!/not registered/i.test(String(e))) throw e;
  }
  const { name, email } = await resolveFiatIdentity(peridot);
  await peridot.fiat.createAccount({ name, email });
}
