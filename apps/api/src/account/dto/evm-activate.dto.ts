import { Type } from "class-transformer";
import { IsInt, IsObject, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

class EvmActivateAssertionDto {
  @IsString()
  id!: string;

  /** hex 32-byte r of the secp256r1 signature over the V3 activation payload */
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: "r must be 0x + 64 hex chars" })
  r!: string;

  /** hex 32-byte s of the secp256r1 signature (low-S enforced on-chain) */
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: "s must be 0x + 64 hex chars" })
  s!: string;

  /** hex authenticatorData (first 32 bytes must equal the RP-ID hash) */
  @IsString()
  authenticatorData!: string;

  /** base64url clientDataJSON (challenge must equal the V3 activation payload) */
  @IsString()
  clientDataJSON!: string;
}

export class EvmActivateDto {
  /** The quoted network fee the client signed against (drift reference, not a cap). */
  @Matches(/^\d+$/, { message: "Quoted network fee must be wei (positive integer)" })
  quotedNetworkFeeWei!: string;

  /** Signed fee-policy version (selects the protocol percentage; unknown versions revert). */
  @IsInt()
  @Min(1)
  @Max(65535)
  feePolicyVersion!: number;

  /** Authorization deadline (unix seconds, TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  deadline!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => EvmActivateAssertionDto)
  assertion!: EvmActivateAssertionDto;
}
