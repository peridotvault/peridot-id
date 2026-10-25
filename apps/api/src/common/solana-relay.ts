// Shared Solana relayer helpers (activation + sponsored withdraw).
// Pure functions over ConfigService + the lazily-required pid-solana module —
// callers keep their lazy `require` (which keeps @solana/web3.js out of Jest's
// transform graph) and pass the module in. Type-only imports are erased.
import type { ConfigService } from "@nestjs/config";
import type { Keypair, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";
import { PID_FEE_POLICY_VERSION } from "./app-config";

type PidSolanaModule = typeof import("@peridotvault/pid-solana");

/** Signed fee-policy version (hardcoded: the on-chain program enforces the same table). */
export function feePolicyVersion(): number {
  return PID_FEE_POLICY_VERSION;
}

/** Canonical protocol-fee table (mirrors the on-chain policy; V3 spec §1).
 *  Fee policy v2 (ANT-544 FR-B): per-chain minima in native base units.
 *  New minima or percentages ship as a NEW version row — never mutate a
 *  published row (spec B7; ANT-543 business model). */
export const PROTOCOL_FEE_BPS_V1 = 5000;
/** Active fee-policy v2 percentage leg (bps; ≤ MAX_PROTOCOL_FEE_BPS enforced). */
export const PROTOCOL_FEE_BPS_V2 = 5000;
export const MAX_PROTOCOL_FEE_BPS = 5000;

/** Chains with a fee-policy minimum (spec B2, native base units). */
export type FeeChain = "stellar" | "solana" | "ethereum" | "base" | "bsc";

/** Per-chain `chainMin` for fee-policy v2 (spec B2 — immutable, versioned). */
export const CHAIN_MIN_FEE_V2: Readonly<Record<FeeChain, bigint>> = Object.freeze({
  // 0.01 XLM (100_000 stroops).
  stellar: 100_000n,
  // 0.000017 SOL (17_000 lamports).
  solana: 17_000n,
  // 0.00000075 ETH (750_000_000_000 wei = 750 gwei). Base shares Ethereum's minimum.
  ethereum: 750_000_000_000n,
  base: 750_000_000_000n,
  // 0.0000023 BNB (2_300_000_000_000 wei, 18 decimals).
  bsc: 2_300_000_000_000n,
});

/** One immutable fee-policy row: percentage leg + per-chain minima. */
export interface FeePolicyRow {
  readonly bps: number;
  readonly chainMin: Readonly<Record<FeeChain, bigint>>;
}

const ZERO_MINIMA: Readonly<Record<FeeChain, bigint>> = Object.freeze({
  stellar: 0n,
  solana: 0n,
  ethereum: 0n,
  base: 0n,
  bsc: 0n,
});

/**
 * Versioned fee-policy table. V1 is frozen at pure-percentage semantics
 * (minima 0 — v1 traffic keeps v1 math, spec B-AC9). V2 adds the B2 minima.
 * Add new versions as new rows only; editing a published row breaks the
 * on-chain mirror and the B3 vectors — `fee-policy.spec.ts` pins both rows.
 */
export const FEE_POLICY_TABLE: Readonly<Record<number, FeePolicyRow>> = Object.freeze({
  1: Object.freeze({ bps: PROTOCOL_FEE_BPS_V1, chainMin: ZERO_MINIMA }),
  2: Object.freeze({ bps: PROTOCOL_FEE_BPS_V2, chainMin: CHAIN_MIN_FEE_V2 }),
});

/** Fee-policy row for a version (throws on unknown versions — `UnknownFeePolicy`). */
export function feePolicyRow(version: number): FeePolicyRow {
  const row = FEE_POLICY_TABLE[version];
  if (!row) throw new Error(`unknown fee policy version: ${version}`);
  if (row.bps > MAX_PROTOCOL_FEE_BPS) throw new Error("protocol fee exceeds maximum");
  return row;
}

/** Protocol-fee bps for a policy version (throws on unknown versions). */
export function protocolFeeBps(version: number): number {
  return feePolicyRow(version).bps;
}

/** `chainMin` (base units) for a chain under a policy version. */
export function chainMinBaseUnits(chain: FeeChain, version: number): bigint {
  return feePolicyRow(version).chainMin[chain];
}

/** protocolFee = floor(networkFee × bps / 10_000). Floor favors the user. */
export function protocolFeeOf(networkFee: bigint, bps: number): bigint {
  return (networkFee * BigInt(bps)) / 10_000n;
}

/**
 * Fee policy v2 platform fee (spec B1):
 * `platformFee = MAX(floor(networkFee × bps / 10_000), chainMin)`,
 * `totalFee = networkFee + platformFee` (additive). Integer floor at every
 * step (NFR-5 — no floats anywhere in fee paths); dust below 1 base unit of
 * the percentage leg falls to the `chainMin` leg automatically.
 */
export function platformFeeOf(networkFee: bigint, chain: FeeChain, version: number): bigint {
  const row = feePolicyRow(version);
  const pct = (networkFee * BigInt(row.bps)) / 10_000n;
  const min = row.chainMin[chain];
  return pct > min ? pct : min;
}

/** `totalFee = networkFee + platformFee` under a policy version. */
export function totalFeeOf(networkFee: bigint, chain: FeeChain, version: number): bigint {
  return networkFee + platformFeeOf(networkFee, chain, version);
}

/**
 * True when a computed total exceeds the user-authorized bound
 * (spec B5 — contracts/programs enforce `totalFee ≤ maxTotalFee`, fail-closed).
 * Exact equality passes (`≤`).
 */
export function exceedsMaxTotalFee(totalFee: bigint, maxTotalFee: bigint): boolean {
  return totalFee > maxTotalFee;
}

/** Quote lifetime (seconds, NFR-3: `expiresAt − quotedAt` ≤ 300s). */
export const QUOTE_TTL_SECS = 300;

/** Drift bound: submit-time attested networkFee must satisfy
 *  attested × QUOTE_DRIFT_DENOMINATOR ≤ quoted × QUOTE_DRIFT_NUMERATOR
 *  (120.00% — integer basis-point-style ratio, no floats). */
export const QUOTE_DRIFT_NUMERATOR = 120;
export const QUOTE_DRIFT_DENOMINATOR = 100;

/** True when an attested fee drifted beyond the allowed multiple of the quote. */
export function exceedsDriftBound(attested: bigint, quoted: bigint): boolean {
  return attested * BigInt(QUOTE_DRIFT_DENOMINATOR) > quoted * BigInt(QUOTE_DRIFT_NUMERATOR);
}

/** Maximum authorization lifetime (seconds) — bounds cross-context replay. */
export const MAX_TTL_SECS = 600;

/**
 * Fee-policy chain for an EVM CAIP-2 reference (fee minima only — the chain
 * row itself is still resolved via the registry). Unknown EVM references fall
 * back to the Ethereum row (the smallest EVM minimum; fail-open only on the
 * floor leg — submit paths additionally re-attest and enforce the user bound).
 */
export function feeChainForEvmReference(reference: string): FeeChain {
  switch (reference) {
    case "56":
    case "97":
      return "bsc";
    case "8453":
    case "84532":
      return "base";
    case "1":
    case "11155111":
    default:
      return "ethereum";
  }
}

export function relayerKeypair(ps: PidSolanaModule, config: ConfigService): Keypair {
  const { Keypair, fromHex } = ps;
  const secret = config.getOrThrow<string>("PID_RELAYER_SECRET");
  return Keypair.fromSecretKey(fromHex(secret));
}

export function treasuryPubkey(ps: PidSolanaModule, config: ConfigService): PublicKey {
  const { PublicKey } = ps;
  const override = config.get<string>("PID_TREASURY_PUBKEY");
  return override ? new PublicKey(override) : relayerKeypair(ps, config).publicKey;
}

export function solanaAdapter(ps: PidSolanaModule, rpcUrl: string, programId: string): SolanaAdapter {
  const { SolanaAdapter, SolanaRpc, PublicKey } = ps;
  return new SolanaAdapter(new SolanaRpc(rpcUrl), new PublicKey(programId));
}
