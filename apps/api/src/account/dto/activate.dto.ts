import { Type } from "class-transformer";
import { IsInt, IsObject, IsString, Max, Min, ValidateNested } from "class-validator";

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
  /** Chain-time expiry (unix seconds) the passkey signed against. */
  @IsInt()
  @Min(0)
  @Max(4102444800)
  expiry!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => ActivateAssertionDto)
  assertion!: ActivateAssertionDto;
}
