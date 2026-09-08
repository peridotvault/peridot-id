import { IsOptional, IsString, Matches } from "class-validator";

export class LoginDto {
  /** Cross-domain success origin to redirect back to after Google (allowlisted). */
  @IsOptional()
  @IsString()
  returnTo?: string;

  /** Registered third-party app this login is for (binds the pid_code to the app). */
  @IsOptional()
  @IsString()
  clientId?: string;
}

export class ExchangeDto {
  @Matches(/^[A-Za-z0-9_-]{20,}$/, { message: "Invalid code" })
  code!: string;

  /** Must match the client_id the code was issued for (when bound). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Backend secret — required at exchange only when the bound app has one set. */
  @IsOptional()
  @IsString()
  clientSecret?: string;
}

/**
 * Mint a pid_code for the CURRENT session (cookie-authenticated). Powers consent
 * screens: an already-logged-in user approves an app without re-authenticating.
 */
export class AuthorizeDto {
  @IsString()
  returnTo!: string;

  @IsOptional()
  @IsString()
  clientId?: string;
}