import { IsOptional, IsString, Matches } from "class-validator";
import { Transform } from "class-transformer";
import { PID_HANDLE_REGEX } from "../../common/pid";
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
 * Claim a pending post-auth PID ticket (Google-verified credential, no identity
 * yet). The handle becomes the permanent `<handle>@pid` — immutable, never
 * reused or reassigned. The ticket is single-use; expired tickets 410.
 */
export class ClaimDto {
  @Transform(({ value }) => (typeof value === "string" ? value.toLowerCase() : value))
  @Matches(PID_HANDLE_REGEX, { message: "handle must be 3-20 chars: lowercase letters, numbers, underscore" })
  handle!: string;
}

/**
 * Client-credentials token for an app's backend (no browser). `clientSecret`
 * is required when the app has one set.
 */
export class AppTokenDto {
  @IsString()
  clientId!: string;

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