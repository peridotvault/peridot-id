/**
 * Shadow PID rows for the testnet stack.
 *
 * Identity is owned by the mainnet deployment, but 13+ tables (chain accounts,
 * authorities, intents, transactions, fiat ledger, XP state) declare a foreign
 * key to `identity.pid`. On testnet those writes would fail FK validation even
 * though the real identity lives elsewhere. The fix is the smallest one that
 * keeps the schema honest: create a bare `Identity` row holding only the pid
 * (status defaults to active) the first time that pid appears, and nothing else
 * — never a credential, profile, or email.
 */

/** PIDs referenced by a Prisma create payload (`{pid}` or `[{pid}, …]`). */
export function pidsInCreateData(data: unknown): string[] {
  const rows = Array.isArray(data) ? data : [data];
  const pids: string[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      const pid = (row as { pid?: unknown }).pid;
      if (typeof pid === "string" && pid.length > 0) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** Models allowed to carry a pid without an identity row on the testnet stack. */
export const SHADOWABLE_PID_MODELS = new Set([
  "Profile",
  "IdentityCredential",
  "Device",
  "ChainAccount",
  "Authority",
  "WalletFeePayer",
  "Intent",
  "Transaction",
  "SecurityEvent",
  "RelayerBroadcast",
  "FiatProviderAccount",
  "FiatProviderTransaction",
  "FiatLedgerEntry",
  "FiatLedgerEvent",
  "UserXpState",
  "XpTaskCompletion",
  "XpLedgerEntry",
  "ClaimTicket",
]);
