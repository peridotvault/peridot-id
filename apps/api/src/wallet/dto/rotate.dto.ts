import { Type } from "class-transformer";
import { IsInt, IsObject, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

class RotateAssertionDto {
  @IsString()
  id!: string;

  /** base64url 64-byte r‖s secp256r1 signature by the CURRENT key */
  @IsString()
  signature!: string;

  @IsString()
  authenticatorData!: string;

  @IsString()
  clientDataJSON!: string;
}

export class RotateAuthorityDto {
  /** Credential id of the current (signing) authority. */
  @IsString()
  oldCredentialId!: string;

  /** Credential id of the already-registered replacement authority. */
  @IsString()
  newCredentialId!: string;

  /** The chain nonce the current key signed against. */
  @Matches(/^\d+$/, { message: "Nonce must be an integer" })
  nonce!: string;

  /** Chain-time expiry (unix seconds) the current key signed against (TTL ≤ 600s enforced). */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => RotateAssertionDto)
  assertion!: RotateAssertionDto;
}

export interface RotateAuthorityResult {
  signature: string;
  status: "confirmed" | "pending";
}
