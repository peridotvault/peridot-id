// Settlement-guard floors for chain fee minima (ANT-730, spec ANT-727 §4.3).
//
// The on-chain immutable values are the settlement guard: a DB MIN_FEE below
// the chain's on-chain floor would quote fine but revert at settlement, so
// admin writes below the floor are rejected (`ChainMinBelowFloor`, AC-10).
// DB values may sit AT or ABOVE the floor (surplus = revenue, safe direction).
//
// Floor schedule = spec §4.2 "Sumber on-chain (backstop)" (fee-policy v2
// design values: `PeridotAccount.sol _chainMinV2` / `fee.rs
// CHAIN_MIN_LAMPORTS_V2`). Lowering a floor below these values needs a policy
// version + contract/program upgrade + Tobias review — never a dashboard edit.
// Monad testnet (10143) and Arbitrum Sepolia (421614) are 0 on-chain and in
// the backend (spec §4.4, AC-14): the pre-v2 backend wrongly applied the
// Ethereum fallback floor to them via `feeChainForEvmReference`.
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

export const CHAIN_FEE_FLOORS: ReadonlyArray<ChainFeeFloor> = Object.freeze([
  { namespace: "eip155", reference: "84532", floor: 750_000_000_000n, source: "PeridotAccount.sol _chainMinV2 (base)" },
  { namespace: "eip155", reference: "97", floor: 2_300_000_000_000n, source: "PeridotAccount.sol _chainMinV2 (bsc)" },
  { namespace: "eip155", reference: "10143", floor: 0n, source: "PeridotAccount.sol _chainMinV2 = 0 (monad, spec §4.4)" },
  { namespace: "eip155", reference: "421614", floor: 0n, source: "PeridotAccount.sol _chainMinV2 = 0 (arbitrum-sepolia, spec §4.4)" },
  { namespace: "solana", reference: SOLANA_DEVNET_REFERENCE, floor: 17_000n, source: "fee.rs CHAIN_MIN_LAMPORTS_V2" },
  { namespace: "solana", reference: SOLANA_TESTNET_REFERENCE, floor: 17_000n, source: "fee.rs CHAIN_MIN_LAMPORTS_V2" },
]);

/** Settlement floor for a chain (0 for unlisted chains — permissive, admin-set minima rule there). */
export function settlementFloorFor(namespace: string, reference: string): bigint {
  return CHAIN_FEE_FLOORS.find((f) => f.namespace === namespace && f.reference === reference)?.floor ?? 0n;
}
