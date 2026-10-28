import { IsEmail, IsOptional, IsString, Matches } from "class-validator";
import { Transform } from "class-transformer";

function normalizeEmail(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

export class EmailStartDto {
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: "Enter a valid email address" })
  email!: string;

  /** Cross-domain success origin to redirect back to after login (allowlisted). */
  @IsOptional()
  @IsString()
  returnTo?: string;

  /** Registered third-party app this login is for (binds the pid_code to the app). */
  @IsOptional()
  @IsString()
  clientId?: string;
}

export class EmailVerifyDto {
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: "Enter a valid email address" })
  email!: string;

  @Matches(/^\d{6}$/, { message: "Enter the 6-digit code" })
  code!: string;

  /** Cross-domain success origin to redirect back to after login (allowlisted). */
  @IsOptional()
  @IsString()
  returnTo?: string;

  /** Registered third-party app this login is for (binds the pid_code to the app). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /**
   * PKCE S256 challenge (H4/ANT-799): required when the app is a public
   * client (no backend secret). 43-128 base64url chars.
   */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{43,128}$/, { message: "Invalid code_challenge" })
  codeChallenge?: string;
}
