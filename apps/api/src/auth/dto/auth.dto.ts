import { IsOptional, IsString, Matches } from "class-validator";

export class LoginDto {
  /** Cross-domain success origin to redirect back to after Google (allowlisted). */
  @IsOptional()
  @IsString()
  returnTo?: string;
}

export class ExchangeDto {
  @Matches(/^[A-Za-z0-9_-]{20,}$/, { message: "Invalid code" })
  code!: string;
}