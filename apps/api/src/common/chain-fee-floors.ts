// Former settlement-guard floors for chain fee minima (ANT-730, spec ANT-727 §4.3).
//
// ANT-743: minima removed — quotes and settlement are pure
// `networkFee × bps / 10_000` with no floor. This module is kept for shape
// compatibility only: `settlementFloorFor` always returns 0n and no admin
// write is gated. The `CHAIN_FEE_FLOORS` rows below are the historical
// (pre-ANT-743) schedule, retained as documentation — they are NOT enforced.
//
// No migration deletes the `chain_min_fees` rows: legacy rows stay in the DB
// but the fee service never reads them (inert). A cleanup migration may drop
// the table once every environment has deployed the ANT-743 backend.
import { SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE } from "./chains";

/** Settlement floor in native base units, keyed by registry natural key. */
export interface ChainFeeFloor {
  namespace: string;
  reference: string;
  /** Floor in native base units (wei for eip155, lamports for solana). */
  floor: bigint;
  /** Where the floor comes from (spec §4.2 backstop column). */
  source: string;
}

/**
 * Historical floor schedule (pre-ANT-743, NOT enforced).
 * @deprecated ANT-743: fee floors removed.
 */
export const CHAIN_FEE_FLOORS: ReadonlyArray<ChainFeeFloor> = Object.freeze([
  { namespace: "eip155", reference: "84532", floor: 750_000_000_000n, source: "PeridotAccount.sol _chainMinV2 (base)" },
  { namespace: "eip155", reference: "97", floor: 2_300_000_000_000n, source: "PeridotAccount.sol _chainMinV2 (bsc)" },
  { namespace: "eip155", reference: "10143", floor: 0n, source: "PeridotAccount.sol _chainMinV2 = 0 (monad, spec §4.4)" },
  { namespace: "eip155", reference: "421614", floor: 0n, source: "PeridotAccount.sol _chainMinV2 = 0 (arbitrum-sepolia, spec §4.4)" },
  { namespace: "solana", reference: SOLANA_DEVNET_REFERENCE, floor: 17_000n, source: "fee.rs CHAIN_MIN_LAMPORTS_V2" },
  { namespace: "solana", reference: SOLANA_TESTNET_REFERENCE, floor: 17_000n, source: "fee.rs CHAIN_MIN_LAMPORTS_V2" },
]);

/**
 * Settlement floor for a chain.
 * @deprecated ANT-743: fee floors removed — always returns 0n.
 */
export function settlementFloorFor(namespace: string, reference: string): bigint {
  void namespace;
  void reference;
  return 0n;
}
