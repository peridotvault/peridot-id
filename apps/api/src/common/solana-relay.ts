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
 *  Fee policy (ANT-743: pure percentage, no per-chain minima). Both rows are
 *  pure `networkFee × bps / 10_000` — v2 keeps its row number so in-flight
 *  signed quotes keep settling; only the floor leg is gone. New percentages
 *  ship as a NEW version row — never mutate a published row (spec B7). */
export const PROTOCOL_FEE_BPS_V1 = 5000;
/** Active fee-policy percentage leg (bps; ≤ MAX_PROTOCOL_FEE_BPS enforced). */
export const PROTOCOL_FEE_BPS_V2 = 5000;
export const MAX_PROTOCOL_FEE_BPS = 5000;

/** Chains with a (now zero) fee-policy minimum slot (spec B2, native base units).
 *  @deprecated ANT-743: minima removed — every leg is 0, quotes are pure
 *  percentage. Kept so existing imports keep compiling. */
export type FeeChain = "stellar" | "solana" | "ethereum" | "base" | "bsc";

/** Per-chain `chainMin` (always 0 since ANT-743 — pure percentage).
 *  @deprecated Minima removed; kept for shape compatibility. */
export const CHAIN_MIN_FEE_V2: Readonly<Record<FeeChain, bigint>> = Object.freeze({
  stellar: 0n,
  solana: 0n,
  ethereum: 0n,
  base: 0n,
  bsc: 0n,
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
 * Versioned fee-policy table. Both rows are pure-percentage (minima 0):
 * v1 keeps its frozen semantics and v2 is the floor-less row (ANT-743).
 * Add new versions as new rows only; editing a published row breaks the
 * on-chain mirror and the B3 vectors — `fee-policy.spec.ts` pins both rows.
 */
export const FEE_POLICY_TABLE: Readonly<Record<number, FeePolicyRow>> = Object.freeze({
  1: Object.freeze({ bps: PROTOCOL_FEE_BPS_V1, chainMin: ZERO_MINIMA }),
  2: Object.freeze({ bps: PROTOCOL_FEE_BPS_V2, chainMin: ZERO_MINIMA }),
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

/**
 * `chainMin` (base units) for a chain under a policy version.
 * @deprecated ANT-743: minima removed — always returns 0n. Kept for
 * shape compatibility; quotes use `protocolFeeOf` (pure percentage).
 */
export function chainMinBaseUnits(chain: FeeChain, version: number): bigint {
  feePolicyRow(version);
  void chain;
  return 0n;
}

/** protocolFee = floor(networkFee × bps / 10_000). Floor favors the user. */
export function protocolFeeOf(networkFee: bigint, bps: number): bigint {
  return (networkFee * BigInt(bps)) / 10_000n;
}

/**
 * Fee policy platform fee (ANT-743: pure percentage, no minima):
 * `platformFee = floor(networkFee × bps / 10_000)`,
 * `totalFee = networkFee + platformFee` (additive). Integer floor at every
 * step (NFR-5 — no floats anywhere in fee paths); dust below 1 base unit of
 * the percentage leg quotes a zero fee (user-favorable).
 */
export function platformFeeOf(networkFee: bigint, chain: FeeChain, version: number): bigint {
  const row = feePolicyRow(version);
  void chain;
  return protocolFeeOf(networkFee, row.bps);
}

/**
 * Pure-percentage platform fee (ANT-743).
 * @deprecated The `minFee` argument is ignored (minima removed). Kept so
 * DB-backed call sites keep compiling; new code should call `protocolFeeOf`.
 */
export function platformFeeWithMin(networkFee: bigint, bps: number, minFee: bigint): bigint {
  void minFee;
  return protocolFeeOf(networkFee, bps);
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
 * Fee-policy chain for an EVM CAIP-2 reference.
 * @deprecated ANT-743: fee floors removed — the mapping is no longer applied
 * to quotes. Kept for chain-label compatibility only.
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

/**
 * ANT-635: the Solana revenue vault is the `["treasury"]` PDA bound to the
 * program id (per cluster) — derived by `SolanaAdapter.treasuryAddress()`,
 * never an env const. `PID_TREASURY_PUBKEY` is deleted; no override exists.
 * (DOKU_* / PID_FIAT_LEDGER_TREASURY_PID are the unrelated fiat rails.)
 */

export function solanaAdapter(ps: PidSolanaModule, rpcUrl: string, programId: string): SolanaAdapter {
  const { SolanaAdapter, SolanaRpc, PublicKey } = ps;
  return new SolanaAdapter(new SolanaRpc(rpcUrl), new PublicKey(programId));
}
