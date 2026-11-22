import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from "class-validator";

/** Login methods an app can switch on/off (dashboard → Integrations). */
export const APP_LOGIN_METHODS = ["passkey", "google", "email", "phantom", "metamask"] as const;
export type AppLoginMethod = (typeof APP_LOGIN_METHODS)[number];

/**
 * A bare http(s) origin: scheme + host + optional port, no path/query/fragment.
 * Trailing slashes are tolerated (normalized away) — anything else is rejected so
 * developers learn the model instead of silently storing something looser.
 *
 * ANT-826 F1: wildcards are never allowed. The host class excludes `*`
 * explicitly (old `[^/:?#]+` admitted `https://*.example.com`), so the DTO
 * layer rejects wildcards with a 400 before normalizeOrigin runs.
 */
export const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?\/?$/;

export class CreatePidAppDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  /** Websites allowed to receive pid_codes and call the API (managed later too). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: "Each entry must be a bare http(s) origin, e.g. https://mygame.dev" })
  allowedOrigins?: string[];
}

export class UpdatePidAppDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: "Each entry must be a bare http(s) origin, e.g. https://mygame.dev" })
  allowedOrigins?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Consent-screen logo. An empty string clears it; https only, because the
   *  wallet renders it on an https page (mixed content is blocked silently). */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^(https:\/\/\S+)?$/i, { message: "logoUrl must be an https URL" })
  logoUrl?: string;

  /** Consent-card one-liner. Empty string clears it; the wallet clamps it to
   *  two lines, so keep it a tagline, not a paragraph. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  /** Enabled login methods. At least one stays on so the app is never locked. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(APP_LOGIN_METHODS.length)
  @ArrayUnique()
  @IsIn(APP_LOGIN_METHODS, { each: true })
  loginMethods?: AppLoginMethod[];
}

/** Per-app fee for one operation (stacks on the global fee). */
export class SetAppFeeDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  percentBps!: number;

  @Matches(/^\d+$/, { message: "minIdr must be whole IDR" })
  minIdr!: string;

  @Matches(/^\d+$/, { message: "maxIdr must be whole IDR" })
  maxIdr!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** Callback endpoint for ledger events (escrow apps). https (or localhost). */
export class SetWebhookDto {
  @IsString()
  @MaxLength(2048)
  @Matches(/^https?:\/\/[^\s]+$/i, { message: "url must be an http(s) URL" })
  url!: string;
}
