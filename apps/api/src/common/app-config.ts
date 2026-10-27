import ms from "ms";

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
 *
 * TTL parsing standard (ANT-227 item 4): every TTL in this file is an
 * `ms`-compatible duration string (e.g. "15m", "24h", "30d"). Never pass a raw
 * env string to `ms()` or `expiresIn` — `ms()` returns `undefined` (not NaN,
 * not a throw) for unparseable input, which silently becomes `NaN` seconds or
 * an Invalid Date downstream. Use `parseTtlMs()` (throws on anything that is
 * not a finite positive duration) and `ttlSeconds()` for `expiresIn` fields.
 */

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL = "30d";
export const GOOGLE_FAMILY_MAX_AGE = "90d";
export const PASSKEY_FAMILY_MAX_AGE = "365d";
/** RP-backend exchange bearer: 24h cliff, no refresh (ANT-227 item 7: was 30d). */
export const SSO_EXCHANGE_TOKEN_TTL = "24h";

export const WEBAUTHN_RP_NAME = "PeridotID";

export const PID_ACTIVATION_POLL_MS = 10_000;
export const PID_ACTIVATION_CONFIRM_INTERVAL_MS = 1_000;
/** Max confirmation rounds for Solana activation (was PID_ACTIVATION_CONFIRM_ATTEMPTS). */
export const PID_ACTIVATION_CONFIRM_ATTEMPTS = 15;
/** Signed fee-policy version (ANT-752 verdict: NO bump — keep signing v2; ANT-747 removed the floor leg so v2 is a pure-percent alias, ANT-544 FR-B). */
export const PID_FEE_POLICY_VERSION = 2;
/** EVM activation poll interval (was PID_EVM_POLL_MS). */
export const PID_EVM_POLL_MS = 30_000;
/** Machine (client-credentials) token TTL for app backends (was APP_TOKEN_TTL). */
export const APP_TOKEN_TTL = "1h";

/**
 * JWT issuer + per-class audiences (ANT-227 item 1). Every token PeridotID
 * mints carries `iss: "peridot-id"` and exactly one audience, so a token for
 * one class can never validate as another even though they share the access
 * secret — confusion no longer relies on `type`/`app`/`scope` claims alone.
 */
export const JWT_ISSUER = "peridot-id";
/** Browser session access token (cookies). */
export const JWT_AUD_SESSION = "pid-session";
/** Opaque refresh token (cookies + account switcher). */
export const JWT_AUD_REFRESH = "pid-refresh";
/** Machine token from POST /v1/auth/token (app backends). */
export const JWT_AUD_APP = "pid-app";
/** RP-backend exchange bearer from the SSO pid_code exchange. */
export const JWT_AUD_SSO = "pid-sso";
/** Every access-class audience the JwtStrategy accepts (refresh has its own). */
export const JWT_ACCESS_AUDIENCES = [JWT_AUD_SESSION, JWT_AUD_APP, JWT_AUD_SSO] as const;

/** App client-secret lifetime from (re)generation (ANT-227 item 5). */
export const APP_CLIENT_SECRET_MAX_AGE = "365d";
/**
 * Previous-secret overlap window (ANT-283): after POST /v1/apps/:id/secret
 * the replaced hash keeps verifying until this TTL elapses, so concurrent
 * deploys pick up the new secret without instant 401s.
 */
export const APP_CLIENT_SECRET_GRACE = "24h";

/**
 * Parse an `ms`-compatible duration string to milliseconds. Throws on
 * anything that is not a finite positive duration — `ms()` itself returns
 * `undefined` for garbage (no throw), which is how NaN TTLs used to slip
 * into `expiresIn` / cookie `maxAge` / session `expiresAt`.
 */
export function parseTtlMs(ttl: string, name: string): number {
  let value: number | undefined;
  try {
    value = ms(ttl);
  } catch {
    value = undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid_ttl:${name}`);
  }
  return value;
}

/** Whole seconds for a TTL string (what `expiresIn` responses carry). */
export function ttlSeconds(ttl: string, name: string): number {
  return Math.floor(parseTtlMs(ttl, name) / 1000);
}

// Fail fast at import: a typo in a hardcoded TTL must break the build/test,
// never silently mint NaN-expiry tokens in production.
for (const [name, ttl] of [
  ["ACCESS_TOKEN_TTL", ACCESS_TOKEN_TTL],
  ["REFRESH_TOKEN_TTL", REFRESH_TOKEN_TTL],
  ["GOOGLE_FAMILY_MAX_AGE", GOOGLE_FAMILY_MAX_AGE],
  ["PASSKEY_FAMILY_MAX_AGE", PASSKEY_FAMILY_MAX_AGE],
  ["SSO_EXCHANGE_TOKEN_TTL", SSO_EXCHANGE_TOKEN_TTL],
  ["APP_TOKEN_TTL", APP_TOKEN_TTL],
  ["APP_CLIENT_SECRET_MAX_AGE", APP_CLIENT_SECRET_MAX_AGE],
  ["APP_CLIENT_SECRET_GRACE", APP_CLIENT_SECRET_GRACE],
] as const) {
  parseTtlMs(ttl, name);
}

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
 * Single source: API_URL (e.g. https://api.peridot.id).
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
