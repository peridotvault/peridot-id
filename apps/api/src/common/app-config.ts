/**
 * Hardcoded non-secret runtime constants (ANT-184).
 *
 * These were previously env-tunable TTLs/names with identical values in every
 * environment (local/dev/test/main). Env-tuning them bought nothing — a typo
 * could silently disable a security cap — so they are constants now. The
 * `*.env.example` files document them as hardcoded (no KEY= line) and the
 * compose file no longer interpolates them.
 *
 * Secrets (DATABASE_URL, JWT_*, GOOGLE_CLIENT_*, BREVO_*, DOKU_*, PID_RELAYER_*)
 * stay env-only and are NOT here.
 */

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL = "30d";
export const GOOGLE_FAMILY_MAX_AGE = "90d";
export const PASSKEY_FAMILY_MAX_AGE = "365d";
export const SSO_EXCHANGE_TOKEN_TTL = "30d";

export const WEBAUTHN_RP_NAME = "PeridotID";

export const PID_ACTIVATION_POLL_MS = 10_000;
export const PID_ACTIVATION_CONFIRM_INTERVAL_MS = 1_000;

/** Local-dev API origin (PORT 3300 is the single source — see main.ts). */
export const DEFAULT_API_DOMAIN = "http://localhost:3300";

/**
 * Derive the Google OAuth callback from the API's own public origin.
 * Single source: API_DOMAIN (e.g. https://api.pid.peridotvault.com).
 * An explicit GOOGLE_CALLBACK_URL env still wins when set (dual-serve edge),
 * but examples no longer carry it — set API_DOMAIN instead.
 */
export function googleCallbackUrl(apiDomain: string): string {
  return `${apiDomain.replace(/\/+$/, "")}/v1/auth/google/callback`;
}

/** Resolve the API origin + callback pair from config (one place). */
export function resolveApiDomain(get: (key: string, def?: string) => unknown): {
  apiDomain: string;
  callbackURL: string;
} {
  const apiDomain = String(get("API_DOMAIN", DEFAULT_API_DOMAIN) ?? DEFAULT_API_DOMAIN).replace(/\/+$/, "");
  const override = get("GOOGLE_CALLBACK_URL", "") as string | undefined;
  return { apiDomain, callbackURL: override ? override : googleCallbackUrl(apiDomain) };
}
