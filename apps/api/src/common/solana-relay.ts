// Shared Solana relayer helpers (activation + sponsored withdraw).
// Pure functions over ConfigService + the lazily-required pid-solana module —
// callers keep their lazy `require` (which keeps @solana/web3.js out of Jest's
// transform graph) and pass the module in. Type-only imports are erased.
import type { ConfigService } from "@nestjs/config";
import type { Keypair, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";

type PidSolanaModule = typeof import("@peridotvault/pid-solana");

export function solanaRpcUrl(config: ConfigService): string {
  return config.get<string>("PID_SOLANA_RPC_URL", "https://api.devnet.solana.com");
}

/** Shared activation/withdraw margin (same rate both flows by design). */
export function activationMarginRate(config: ConfigService): number {
  const n = Number(config.get<string>("PID_ACTIVATION_MARGIN_RATE", "0.5"));
  return Number.isFinite(n) && n >= 0 ? n : 0.5;
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

export function solanaAdapter(ps: PidSolanaModule, config: ConfigService): SolanaAdapter {
  const { SolanaAdapter, SolanaRpc } = ps;
  return new SolanaAdapter(new SolanaRpc(solanaRpcUrl(config)));
}
