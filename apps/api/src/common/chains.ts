// Single source of truth for well-known chain references. The chains registry
// (seed + admin API) must contain matching rows — chain_accounts has a hard FK
// to chains(namespace, reference), so these constants and the seed must agree.
export const SOLANA_NAMESPACE = "solana";
export const EIP155_NAMESPACE = "eip155";
/**
 * Registry key of the default Solana row (serves devnet RPC).
 * Legacy value: a truncated form of an older testnet genesis hash. It is kept
 * byte-stable as an opaque registry key — chain_accounts FKs by id, and
 * renaming it would orphan existing rows for zero benefit. Do NOT reuse this
 * value to key any other row (see SOLANA_TESTNET_REFERENCE).
 */
export const SOLANA_MAINNET_REFERENCE = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
/** Honest alias: this key identifies the devnet-serving registry row. */
export const SOLANA_DEVNET_REFERENCE = SOLANA_MAINNET_REFERENCE;
/**
 * Registry key of the solana-testnet row. This is the live testnet genesis
 * hash, verified via `getGenesisHash` against api.testnet.solana.com on
 * 2026-10-18 (the truncated legacy key above no longer matches testnet).
 */
export const SOLANA_TESTNET_REFERENCE = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export const ACCOUNT_TYPE_SMART = "smart_account";
export const ACCOUNT_TYPE_LINKED = "linked_address";

/** Canonical smart-account program id — seed default / last-resort fallback.
 *  The live value lives in the chain registry (`program` contract); admins
 *  change it in the workspace, not in env. */
export const SOLANA_PROGRAM_ID = "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT";
/** Testnet smart-account program id — seed default for the solana-testnet row.
 *  Fresh test-only keypair (NOT the devnet keypair): reported by Trevor
 *  (ANT-26 chain ops, comment d4ba0f9a) as board-directed. On-chain deploy to
 *  testnet is still pending (ANT-26); re-verify with getAccountInfo post-deploy.
 *  The live value stays in the registry (`program` contract), not env. */
export const SOLANA_TESTNET_PROGRAM_ID = "D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3";
/** Public devnet RPC — seed default when the registry has no Solana chain. */
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
/** Public testnet RPC — seed default for the solana-testnet registry row. */
export const SOLANA_TESTNET_RPC = "https://api.testnet.solana.com";

/**
 * Server-side Solana network selection (ANT-15 req 1). The server resolves
 * this against active registry rows — never trust a client-supplied chain id.
 * Per-user/session persistence + the HTTP surface are defined by the ANT-15
 * spec (Theo, ANT-23); the registry layer accepts the selection and defaults
 * to "devnet" (current behavior) when omitted.
 */
export type SolanaSelection = "devnet" | "testnet";

/** Registry reference for a selection ("devnet" is the legacy default row). */
export function solanaReferenceFor(selection: SolanaSelection): string {
  return selection === "testnet" ? SOLANA_TESTNET_REFERENCE : SOLANA_DEVNET_REFERENCE;
}
