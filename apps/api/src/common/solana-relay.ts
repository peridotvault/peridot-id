// Shared Solana relayer helpers (activation + sponsored withdraw).
// Pure functions over ConfigService + the lazily-required pid-solana module —
// callers keep their lazy `require` (which keeps @solana/web3.js out of Jest's
// transform graph) and pass the module in. Type-only imports are erased.
import type { ConfigService } from "@nestjs/config";
import type { Keypair, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";

type PidSolanaModule = typeof import("@peridotvault/pid-solana");

/** Shared activation/withdraw margin (retired in V3 — kept for config compat only).
 *  V3 quotes the raw network estimate; the protocol fee is a separate percentage. */
export function activationMarginRate(config: ConfigService): number {
  const n = Number(config.get<string>("PID_ACTIVATION_MARGIN_RATE", "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Signed fee-policy version (selects the protocol percentage; chain contracts enforce it). */
export function feePolicyVersion(config: ConfigService): number {
  const n = Number(config.get<string>("PID_FEE_POLICY_VERSION", "1"));
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 1;
}

/** Canonical protocol-fee table (mirrors the on-chain policy; V3 spec §1). */
export const PROTOCOL_FEE_BPS_V1 = 5000;
export const MAX_PROTOCOL_FEE_BPS = 5000;

/** Protocol-fee bps for a policy version (throws on unknown versions). */
export function protocolFeeBps(version: number): number {
  if (version !== 1) throw new Error(`unknown fee policy version: ${version}`);
  if (PROTOCOL_FEE_BPS_V1 > MAX_PROTOCOL_FEE_BPS) throw new Error("protocol fee exceeds maximum");
  return PROTOCOL_FEE_BPS_V1;
}

/** protocolFee = floor(networkFee × bps / 10_000). Floor favors the user. */
export function protocolFeeOf(networkFee: bigint, bps: number): bigint {
  return (networkFee * BigInt(bps)) / 10_000n;
}

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
