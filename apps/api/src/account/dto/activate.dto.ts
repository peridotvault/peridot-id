import { Type } from "class-transformer";
import { IsInt, IsObject, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

class ActivateAssertionDto {
  @IsString()
  id!: string;

  /** base64url 64-byte r‖s secp256r1 signature over the activation payload */
  @IsString()
  signature!: string;

  @IsString()
  authenticatorData!: string;

  @IsString()
  clientDataJSON!: string;
}

export class ActivateDto {
  /** Chain-time expiry (unix seconds) the passkey signed against (TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  /** The quoted network fee the client signed against (drift reference, not a cap). */
  @IsString()
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

  @IsObject()
  @ValidateNested()
  @Type(() => ActivateAssertionDto)
  assertion!: ActivateAssertionDto;
}
