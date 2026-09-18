import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min } from "class-validator";

const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d+$/;

/** Owner-approved gameplay session grant (mirrors `register_session`; see WHITEPAPER.md §11). */
export class RegisterSessionDto {
  /** Vault PDA the session attaches to (base58). */
  @Matches(PUBKEY, { message: "vault must be a base58 pubkey" })
  vault!: string;

  /** `sha256(pid)` account id (hex, 32 bytes) — binds the session to the identity. */
  @Matches(HEX32, { message: "accountId must be 0x + 64 hex chars" })
  accountId!: string;

  /** Ed25519 session keypair pubkey (base58) — signs gameplay envelopes. */
  @Matches(PUBKEY, { message: "sessionPubkey must be a base58 pubkey" })
  sessionPubkey!: string;

  /** The one allowlisted game program (base58). */
  @Matches(PUBKEY, { message: "allowedProgram must be a base58 pubkey" })
  allowedProgram!: string;

  /** Session hard expiry (unix seconds, ≤ 24h out). */
  @IsInt()
  @Min(0)
  expiresAt!: number;

  /** Whether the game program currently has an upgrade authority. */
  @IsBoolean()
  recordedHasAuthority!: boolean;

  /** Upgrade authority at registration (base58, required when recordedHasAuthority). */
  @IsOptional()
  @Matches(PUBKEY, { message: "recordedAuthority must be a base58 pubkey" })
  recordedAuthority?: string;

  /** ProgramData slot at registration. */
  @IsString()
  @Matches(UINT, { message: "recordedSlot must be a uint string" })
  recordedSlot!: string;

  /** Owner-authorization deadline (unix seconds, TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  deadline!: number;

  /** Owner nonce the registration consumes. */
  @IsString()
  @Matches(UINT, { message: "nonce must be a uint string" })
  nonce!: string;
}
