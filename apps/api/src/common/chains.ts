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

/** Devnet smart-account program id — seed default / last-resort fallback.
 *  Fresh devnet program (ANT-68 Option B, board-authorized via ANT-69):
 *  deployed 2026-10-19 from source commit 4782860, upgrade authority
 *  9Et9ezFN41GaCdRx8xcwXawNGgPAySo9gc3aKQa2U3nD (Trevor-held deployer).
 *  Deploy tx 3kXKE3...f1bsKqK3 (devnet). The live value stays in the chain
 *  registry (`program` contract); admins change it in the workspace, not in env. */
export const SOLANA_PROGRAM_ID = "9oMG7eLaq8NxHJEr5nzPc9CgLc8gprzBGVn6sxunECce";
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

/** Stellar namespace (S1 §5: `namespace: "stellar"`). */
export const STELLAR_NAMESPACE = "stellar";
/**
 * Registry key of the stellar-testnet row (S1 §5.2, OQ-S1 proposed).
 * Stellar has no EIP-155 chain-id and no Solana genesis-hash convention to
 * copy, so the F1 `network_id` hex is the deterministic key: it is already
 * bound in every v2 digest and is exactly 64 chars.
 * `sha256("Test SDF Network ; September 2015")` — == `env.ledger().network_id()`
 * on testnet (host truth) and `networkId(TESTNET_PASSPHRASE)` in
 * `packages/stellar` (AC5.3 parity). If the CTO picks the raw passphrase
 * string per OQ-S1, re-key this constant and the seed mechanically.
 */
export const STELLAR_TESTNET_REFERENCE =
  "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472";
/** Horizon testnet RPC — seed default for the stellar-testnet row. */
export const STELLAR_TESTNET_RPC = "https://horizon-testnet.stellar.org";
/** Explorer base for the stellar-testnet row. */
export const STELLAR_TESTNET_EXPLORER = "https://stellarchain.io/testnet";

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

/**
 * Client selection transport (ANT-15 spec §8, OQ-5 session-scoped).
 * The wallet sends its network-mode selection per request; the server
 * resolves RPC/program from the registry and is the source of truth.
 * No per-user preference is stored server-side in v1.
 */
export const CHAIN_REFERENCE_HEADER = "x-chain-reference";
export const CHAIN_REFERENCE_QUERY = "chainReference";
/** Fail-closed error code for unknown selections (ANT-15 AC-1.4). */
export const UNKNOWN_CHAIN_CODE = "UNKNOWN_CHAIN";
/** Boundary guard for client-supplied references (type + length checked at the edge). */
export const MAX_CHAIN_REFERENCE_LENGTH = 128;
