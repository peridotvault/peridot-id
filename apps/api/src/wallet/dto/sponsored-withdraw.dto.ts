import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

class AssertionDto {
  @IsString()
  id!: string;

  /** base64url 64-byte r‖s secp256r1 signature */
  @IsString()
  signature!: string;

  @IsString()
  authenticatorData!: string;

  @IsString()
  clientDataJSON!: string;
}

/**
 * ANT-729 (WS3): first-action authorization for lazy activation. Required when
 * the account is not yet ACTIVE — carries the passkey-signed activation leg
 * so the backend can land `[activate_v4 + spend]` in one flow (spec WS1 §7.2).
 */
export class FirstActionDto {
  /** Chain-time expiry (unix seconds) the activation passkey signed against. */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  /** Signed fee-policy version for the activation leg. */
  @IsInt()
  @Min(1)
  @Max(65535)
  feePolicyVersion!: number;

  /** The quoted activation estimate the client signed against (drift reference). */
  @Matches(/^\d+$/, { message: "Quoted activation fee must be an integer" })
  quotedActivationLamports!: string;

  /** User-approved upper bound on the activation leg's `networkFee + platformFee`. */
  @Matches(/^\d+$/, { message: "Activation max total fee must be an integer" })
  maxTotalFeeLamports!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => AssertionDto)
  assertion!: AssertionDto;
}

export class SponsoredWithdrawDto {
  @IsString()
  asset!: string; // "SOL" or an SPL mint address
  @Matches(SOLANA_PUBKEY_RE, { message: "Destination is invalid" })
  to!: string;

  @Matches(/^\d+$/, { message: "Amount must be lamports (positive integer)" })
  amount!: string;

  /** The chain nonce the passkey signed against. */
  @Matches(/^\d+$/, { message: "Nonce must be an integer" })
  nonce!: string;

  /** Chain-time expiry (unix seconds) the passkey signed against (TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  /** The quoted network fee the client signed against (drift reference, not a cap). */
  @Matches(/^\d+$/, { message: "Quoted network fee must be an integer" })
  quotedNetworkFeeLamports!: string;

  /**
   * User-approved upper bound on `networkFee + platformFee` carried by the
   * passkey-signed V4 authorization (spec B5). Required — no silent default
   * (spec edge case 2); submit enforces `totalFee ≤ maxTotalFee` pre-broadcast.
   */
  @Matches(/^\d+$/, { message: "Max total fee must be an integer" })
  maxTotalFeeLamports!: string;

  /** Signed fee-policy version (selects the protocol percentage; unknown versions rejected on-chain). */
  @IsInt()
  @Min(1)
  @Max(65535)
  feePolicyVersion!: number;

  @IsOptional()
  @IsString()
  metadata?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => AssertionDto)
  assertion!: AssertionDto;

  /** First-action authorization (required when the account is not yet ACTIVE). */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FirstActionDto)
  activation?: FirstActionDto;
}

export class WithdrawQuoteDto {
  @IsString()
  asset!: string; // for future estimate refinement; SOL/token same base fee
}

export interface SponsoredWithdrawResult {
  signature: string;
  networkFeeLamports: string;
  protocolFeeLamports: string;
  status: "confirmed" | "pending";
}