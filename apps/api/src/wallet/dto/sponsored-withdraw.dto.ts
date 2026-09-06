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

  /** Chain-time expiry (unix seconds) the passkey signed against. */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  /** The signed relay fee (lamports) reimbursed to the Peridot treasury. */
  @Matches(/^\d+$/, { message: "Relay fee must be an integer" })
  relayFeeLamports!: string;

  @IsOptional()
  @IsString()
  metadata?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => AssertionDto)
  assertion!: AssertionDto;
}

export class WithdrawQuoteDto {
  @IsString()
  asset!: string; // for future estimate refinement; SOL/token same base fee
}

export interface SponsoredWithdrawResult {
  signature: string;
  relayFeeLamports: string;
  status: "confirmed" | "pending";
}