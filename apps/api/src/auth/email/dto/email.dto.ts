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
}
