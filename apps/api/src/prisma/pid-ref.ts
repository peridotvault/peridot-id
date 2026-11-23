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

/**
 * PIDs a write will reference. `upsert` carries neither `data` nor a plain
 * `where.pid` on every model, so all three shapes are read here — missing one
 * means a first-write FK failure on the testnet stack.
 */
export function pidsInWriteArgs(args: unknown): string[] {
  const a = (args ?? {}) as { data?: unknown; create?: unknown; where?: { pid?: unknown } };
  return [
    ...new Set([
      ...pidsInCreateData(a.data),
      ...pidsInCreateData(a.create),
      ...(typeof a.where?.pid === "string" ? [a.where.pid] : []),
    ]),
  ];
}

/**
 * Models allowed to carry a pid without an identity row on the testnet stack.
 * Identity-owned tables (profile, credential, device, claim ticket) are
 * deliberately absent: their routes are forwarded to mainnet, so a local write
 * is a bug that must fail loudly instead of silently forging an identity row.
 */
export const SHADOWABLE_PID_MODELS = new Set([
  "ChainAccount",
  "Authority",
  "WalletFeePayer",
  "Intent",
  "Transaction",
  "SecurityEvent",
  "RelayerBroadcast",
  "LoginEvent",
  "FiatProviderAccount",
  "FiatProviderTransaction",
  "FiatLedgerEntry",
  "FiatLedgerEvent",
  "UserXpState",
  "XpTaskCompletion",
  "XpLedgerEntry",
]);
