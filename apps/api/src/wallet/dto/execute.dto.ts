import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

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

class ExecuteMetaDto {
  @Matches(SOLANA_PUBKEY_RE, { message: "Meta address is invalid" })
  address!: string;

  @IsBoolean()
  writable!: boolean;

  @IsBoolean()
  signer!: boolean;
}

export class SponsoredExecuteDto {
  /** Target program (never the smart-account program — rejected fail-fast). */
  @Matches(SOLANA_PUBKEY_RE, { message: "Target is invalid" })
  target!: string;

  /** Bound CPI accounts, in order (≤ 64; the PDA must be among them as a signer). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ExecuteMetaDto)
  metas!: ExecuteMetaDto[];

  /** base64url inner instruction data (≤ 10_240 bytes). */
  @IsString()
  @MaxLength(13_660) // ceil(10240 / 3) * 4
  @Matches(BASE64URL_RE, { message: "Data must be base64url" })
  data!: string;

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

  /** Signed fee-policy version (selects the protocol percentage; unknown versions rejected on-chain). */
  @IsInt()
  @Min(1)
  @Max(65535)
  feePolicyVersion!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => AssertionDto)
  assertion!: AssertionDto;
}

export class ExecuteQuoteDto {
  @Matches(SOLANA_PUBKEY_RE, { message: "Target is invalid" })
  target!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ExecuteMetaDto)
  metas!: ExecuteMetaDto[];

  /** base64url inner instruction data (length shapes the estimate; content is opaque). */
  @IsString()
  @MaxLength(13_660)
  @Matches(BASE64URL_RE, { message: "Data must be base64url" })
  data!: string;
}
