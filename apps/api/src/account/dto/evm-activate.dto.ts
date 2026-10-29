import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class EvmActivateAssertionDto {
  @IsString()
  id!: string;

  /** hex 32-byte r of the secp256r1 signature over the V4 activation payload */
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: "r must be 0x + 64 hex chars" })
  r!: string;

  /** hex 32-byte s of the secp256r1 signature (low-S enforced on-chain) */
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: "s must be 0x + 64 hex chars" })
  s!: string;

  /** hex authenticatorData (first 32 bytes must equal the RP-ID hash) */
  @IsString()
  authenticatorData!: string;

  /** base64url clientDataJSON (challenge must equal the V4 activation payload) */
  @IsString()
  clientDataJSON!: string;
}

export class EvmActivateDto {
  /** The quoted network fee the client signed against (drift reference, not a cap). */
  @Matches(/^\d+$/, { message: "Quoted network fee must be wei (positive integer)" })
  quotedNetworkFeeWei!: string;

  /** Signed fee-policy version (2 = V4 only; policy 1 sunset is rejected — re-quote). */
  @IsInt()
  @Min(2)
  @Max(2)
  feePolicyVersion!: number;

  /** User-approved bound on `networkFee + protocolFee` for THIS activation (wei, V4 B5/B6).
   * REQUIRED; the contract reverts FeeExceedsMax when
   * the attested total exceeds it. */
  @IsOptional()
  @Matches(/^\d+$/, { message: "maxTotalFee must be wei (positive integer)" })
  maxTotalFeeWei?: string;

  /** Authorization deadline (unix seconds, TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  deadline!: number;

  /**
   * WS1 §7.2 idempotency key (client uuid; server generates one when absent).
   * A retry with the same id never deploys twice (ACTIVE → no-op view,
   * in-flight → `ActivationInProgress` 409). Echoed in errors and logs.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  firstActionId?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmActivateAssertionDto)
  assertion!: EvmActivateAssertionDto;
}
