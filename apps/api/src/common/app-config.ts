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
/** Max confirmation rounds for Solana activation (was PID_ACTIVATION_CONFIRM_ATTEMPTS). */
export const PID_ACTIVATION_CONFIRM_ATTEMPTS = 15;
/** Signed fee-policy version (was PID_FEE_POLICY_VERSION; V1 = fixed 50% protocol fee). */
export const PID_FEE_POLICY_VERSION = 1;
/** EVM activation poll interval (was PID_EVM_POLL_MS). */
export const PID_EVM_POLL_MS = 30_000;
/** Machine (client-credentials) token TTL for app backends (was APP_TOKEN_TTL). */
export const APP_TOKEN_TTL = "1h";

/** Local-dev API origin (PORT 3300 is the single source — see main.ts). */
export const DEFAULT_API_DOMAIN = "http://localhost:3300";

/**
 * ONE service-URL set (ANT-193): every first-party origin the API trusts is
 * derived from these four. API_URL is canonical; API_DOMAIN still reads as a
 * deprecated cutover fallback (removed once Infisical carries API_URL).
 * WALLET_URL replaces CLIENT_SUCCESS_URL (kept as deprecated fallback).
 * DASHBOARD_URL / DOCS_URL are optional — included only when set.
 */
export interface ServiceUrls {
  apiUrl: string;
  walletUrl: string;
  dashboardUrl: string | null;
  docsUrl: string | null;
}

/** Local-dev wallet origin (matches the wallet dev server). */
export const DEFAULT_WALLET_URL = "http://localhost:3302";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
}

/** Resolve the service-URL set from config (one place). */
export function resolveServiceUrls(get: (key: string, def?: string) => unknown): ServiceUrls {
  const apiUrl = str(get("API_URL")) || str(get("API_DOMAIN")) || DEFAULT_API_DOMAIN;
  const walletUrl = str(get("WALLET_URL")) || str(get("CLIENT_SUCCESS_URL")) || DEFAULT_WALLET_URL;
  return {
    apiUrl,
    walletUrl,
    dashboardUrl: str(get("DASHBOARD_URL")) || null,
    docsUrl: str(get("DOCS_URL")) || null,
  };
}

/** Every configured service origin (no empties, deduped, trailing slashes stripped). */
export function serviceOrigins(urls: ServiceUrls): string[] {
  return [...new Set([urls.apiUrl, urls.walletUrl, urls.dashboardUrl, urls.docsUrl].filter(Boolean))] as string[];
}

/**
 * WebAuthn RP ID: explicit WEBAUTHN_RP_ID wins (passkey continuity — existing
 * credentials are bound to it, so per-env pins in deploy examples stay), else
 * the wallet hostname (port stripped), else localhost for dev/tests.
 */
export function webauthnRpId(get: (key: string, def?: string) => unknown, urls?: ServiceUrls): string {
  const override = str(get("WEBAUTHN_RP_ID"));
  if (override) return override;
  const wallet = (urls ?? resolveServiceUrls(get)).walletUrl;
  try {
    const host = new URL(wallet).hostname.trim();
    if (host) return host;
  } catch {
    // fall through to localhost
  }
  return "localhost";
}

/** True when the API serves HTTPS (cookie `secure` derives from this). */
export function apiServesHttps(get: (key: string, def?: string) => unknown, urls?: ServiceUrls): boolean {
  try {
    return new URL((urls ?? resolveServiceUrls(get)).apiUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Derive the Google OAuth callback from the API's own public origin.
 * Single source: API_URL (e.g. https://api.pid.peridotvault.com).
 * An explicit GOOGLE_CALLBACK_URL env still wins when set (dual-serve edge),
 * but examples no longer carry it — set API_URL instead.
 */
export function googleCallbackUrl(apiDomain: string): string {
  return `${apiDomain.replace(/\/+$/, "")}/v1/auth/google/callback`;
}

/** Resolve the API origin + callback pair from config (one place). */
export function resolveApiDomain(get: (key: string, def?: string) => unknown): {
  apiDomain: string;
  callbackURL: string;
} {
  const apiDomain = resolveServiceUrls(get).apiUrl;
  const override = get("GOOGLE_CALLBACK_URL", "") as string | undefined;
  return { apiDomain, callbackURL: override ? override : googleCallbackUrl(apiDomain) };
}
