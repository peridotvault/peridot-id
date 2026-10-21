import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import ms from "ms";
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, apiServesHttps } from "./app-config";

export const ACCESS_COOKIE = "pid_access";
export const REFRESH_COOKIE = "pid_refresh";
export const CLAIM_COOKIE = "pid_claim";
/** Prefix for the per-identity refresh cookie of a linked account. */
export const ACCOUNT_REFRESH_PREFIX = "pid_refresh__";
const REFRESH_PATH = "/v1/auth";
const CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * Cookie name for an identity's own refresh token. Cookie names can't contain
 * `@`, so the pid is hashed — the value is the credential, the name is opaque.
 */
export function accountRefreshCookieName(pid: string): string {
  return ACCOUNT_REFRESH_PREFIX + createHash("sha256").update(pid).digest("hex").slice(0, 16);
}

/** Names of every linked-account refresh cookie present on the request. */
export function accountRefreshCookieNames(cookies: Record<string, string> | undefined): string[] {
  return Object.keys(cookies ?? {}).filter((n) => n.startsWith(ACCOUNT_REFRESH_PREFIX));
}

/**
 * Cookie attributes derived from the ONE service-URL set (ANT-193):
 * - `secure` from the API origin protocol (https in every deployed env),
 *   explicit COOKIE_SECURE wins when set (edge: http API behind https proxy).
 *   Fail-closed (ANT-228): with no explicit COOKIE_SECURE, an https API
 *   origin yields `Secure` cookies — every deployed env serves https, so
 *   prod is safe by default; only localhost dev (http origin) gets `false`.
 * - `domain` defaults to host-only (dual-serve safe: a Domain suffix set from
 *   one dual-serve host is silently dropped on the other — see compose.yaml);
 *   explicit COOKIE_DOMAIN wins when set (edge: cross-subdomain visibility).
 * - `sameSite` defaults to lax (same-site subdomains included). `none` is
 *   REJECTED (ANT-228): browsers drop `SameSite=None` without `Secure`, and
 *   cross-site cookie auth without a CSRF token (double-submit or
 *   synchronizer — not yet implemented) is a session-riding vector. Wallet
 *   cookies stay Lax until a CSRF guard lands.
 * - `__Host-` prefix considered and deliberately NOT adopted (ANT-228): it
 *   forbids the `Domain` attribute, which dual-serve needs when per-env
 *   cross-subdomain visibility is pinned. `Path=/` + `Secure` + `HttpOnly`
 *   gives equivalent fixation resistance without breaking dual-serve.
 */
function cookieAttrs(config: ConfigService): { secure: boolean; domain: string; sameSite: "lax" | "strict" | "none" } {
  const get = (key: string, def?: string): unknown => config.get(key, def);
  const secureRaw = config.get<string>("COOKIE_SECURE", "");
  const secure = secureRaw ? secureRaw === "true" : apiServesHttps(get);
  const sameSiteRaw = (config.get<string>("COOKIE_SAMESITE", "lax") ?? "lax").toLowerCase();
  if (sameSiteRaw === "none") {
    throw new Error("COOKIE_SAMESITE=none requires a CSRF guard (double-submit tokens not yet implemented) — refusing cross-site cookies");
  }
  return {
    secure,
    domain: config.get<string>("COOKIE_DOMAIN", ""),
    sameSite: sameSiteRaw === "strict" ? "strict" : "lax",
  };
}

function baseOpts(config: ConfigService): Record<string, unknown> {
  const { secure, domain, sameSite } = cookieAttrs(config);
  const opts: Record<string, unknown> = { httpOnly: true, sameSite, secure };
  // Omitting `domain` for localhost avoids a known browser cookie-rejection gotcha.
  if (domain && domain !== "localhost") opts.domain = domain;
  return opts;
}

/**
 * Clearing must mirror the set flags (M5): a `clearCookie` is matched by
 * name + domain + path, and strict clients compare the full attribute set —
 * a clear missing `domain`/`path` (or with different Secure/SameSite/
 * HttpOnly) can silently no-op, leaving the session alive after logout.
 * Every clear below therefore reuses the exact `baseOpts` the setter used.
 */
function clearOpts(config: ConfigService, path?: string): Record<string, unknown> {
  return path ? { ...baseOpts(config), path } : baseOpts(config);
}

/**
 * Access cookies are scoped to `/` (ANT-228): without an explicit Path the
 * browser defaults it to the *issuing request path* (`/v1/auth/...`), so the
 * access cookie would silently stop being sent on other routes. Refresh and
 * claim cookies stay path-restricted to `/v1/auth` (least privilege — they
 * are only ever consumed there). Every clear mirrors its set path, otherwise
 * the clear is a no-op and the session survives logout.
 */
const ACCESS_PATH = "/";

export function setAuthCookies(res: Response, config: ConfigService, access: string, refresh: string, pid?: string): void {
  const opts = baseOpts(config);
  res.cookie(ACCESS_COOKIE, access, { ...opts, path: ACCESS_PATH, maxAge: ms(ACCESS_TOKEN_TTL) });
  res.cookie(REFRESH_COOKIE, refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(REFRESH_TOKEN_TTL) });
  // Remember this identity so the wallet can switch back to it without a re-login.
  if (pid) setAccountRefreshCookie(res, config, pid, refresh);
}

/** Rotate only the active identity's cookies (used when switching accounts). */
export function setActiveAuthCookies(res: Response, config: ConfigService, access: string, refresh: string): void {
  const opts = baseOpts(config);
  res.cookie(ACCESS_COOKIE, access, { ...opts, path: ACCESS_PATH, maxAge: ms(ACCESS_TOKEN_TTL) });
  res.cookie(REFRESH_COOKIE, refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(REFRESH_TOKEN_TTL) });
}

export function setAccountRefreshCookie(res: Response, config: ConfigService, pid: string, refresh: string): void {
  const opts = baseOpts(config);
  res.cookie(accountRefreshCookieName(pid), refresh, {
    ...opts,
    path: REFRESH_PATH,
    maxAge: ms(REFRESH_TOKEN_TTL),
  });
}

export function clearAccountRefreshCookie(res: Response, config: ConfigService, pid: string): void {
  res.clearCookie(accountRefreshCookieName(pid), clearOpts(config, REFRESH_PATH));
}

/** Clear a linked-account refresh cookie by its exact cookie name (no pid needed). */
export function clearAccountRefreshCookieByName(res: Response, config: ConfigService, name: string): void {
  res.clearCookie(name, clearOpts(config, REFRESH_PATH));
}

/** Clear every linked-account refresh cookie present on the request. Returns the cleared names. */
export function clearAllAccountRefreshCookies(
  res: Response,
  config: ConfigService,
  cookies: Record<string, string> | undefined,
): string[] {
  const names = accountRefreshCookieNames(cookies);
  for (const name of names) clearAccountRefreshCookieByName(res, config, name);
  return names;
}

/**
 * App-scoped session cookies. A first-party client app (e.g. the workspace)
 * carries its OWN session under `pid_access_<scope>` / `pid_refresh_<scope>`,
 * separate from the wallet's unscoped session — so logging out of the app never
 * touches the wallet, and vice versa. Distinct from the account cookies
 * (`pid_refresh__<hash>`, double underscore).
 */
const SCOPE_RE = /^[a-z0-9_]{1,32}$/;

/** Sanitize an app scope from a request header; null when absent/invalid. */
export function normalizeScope(scope: string | string[] | undefined): string | null {
  const raw = Array.isArray(scope) ? scope[0] : scope;
  const s = (raw ?? "").trim().toLowerCase();
  return SCOPE_RE.test(s) ? s : null;
}

export function scopeAccessCookie(scope: string): string {
  return `pid_access_${scope}`;
}
export function scopeRefreshCookie(scope: string): string {
  return `pid_refresh_${scope}`;
}

export function setScopedAuthCookies(res: Response, config: ConfigService, scope: string, access: string, refresh: string): void {
  const opts = baseOpts(config);
  res.cookie(scopeAccessCookie(scope), access, { ...opts, path: ACCESS_PATH, maxAge: ms(ACCESS_TOKEN_TTL) });
  res.cookie(scopeRefreshCookie(scope), refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(REFRESH_TOKEN_TTL) });
}

export function clearScopedAuthCookies(res: Response, config: ConfigService, scope: string): void {
  res.clearCookie(scopeAccessCookie(scope), clearOpts(config, ACCESS_PATH));
  res.clearCookie(scopeRefreshCookie(scope), clearOpts(config, REFRESH_PATH));
}

/**
 * Scope encoded in a cookie name, or null. Account cookies (`pid_refresh__<hash>`,
 * double underscore, refresh-only) are never scopes — even though `_…` passes
 * SCOPE_RE, the refresh side excludes a leading underscore to avoid colliding
 * with them. (Access cookies have no account counterpart, so any SCOPE_RE
 * match counts.)
 */
function scopeFromCookieName(name: string): string | null {
  const accessPrefix = "pid_access_";
  const refreshPrefix = "pid_refresh_";
  if (name.startsWith(accessPrefix)) {
    const scope = name.slice(accessPrefix.length);
    return SCOPE_RE.test(scope) ? scope : null;
  }
  if (name.startsWith(refreshPrefix)) {
    const scope = name.slice(refreshPrefix.length);
    return SCOPE_RE.test(scope) && !scope.startsWith("_") ? scope : null;
  }
  return null;
}

/** Clear every app-scoped session present on the request. Returns the cleared scopes. */
export function clearAllScopedAuthCookies(
  res: Response,
  config: ConfigService,
  cookies: Record<string, string> | undefined,
): string[] {
  const scopes = new Set<string>();
  for (const name of Object.keys(cookies ?? {})) {
    const scope = scopeFromCookieName(name);
    if (scope) scopes.add(scope);
  }
  for (const scope of scopes) clearScopedAuthCookies(res, config, scope);
  return [...scopes];
}

export function clearAuthCookies(res: Response, config: ConfigService): void {
  res.clearCookie(ACCESS_COOKIE, clearOpts(config, ACCESS_PATH));
  res.clearCookie(REFRESH_COOKIE, clearOpts(config, REFRESH_PATH));
}

/** Pending-claim ticket cookie (opaque ticket id, 10 min, auth paths only). */
export function setClaimCookie(res: Response, config: ConfigService, ticketId: string): void {
  const opts = { ...baseOpts(config), path: REFRESH_PATH, maxAge: CLAIM_TTL_MS };
  res.cookie(CLAIM_COOKIE, ticketId, opts);
}

export function clearClaimCookie(res: Response, config: ConfigService): void {
  res.clearCookie(CLAIM_COOKIE, clearOpts(config, REFRESH_PATH));
}

/**
 * OAuth state nonce cookie (M3): HttpOnly, 10-min TTL, auth paths only. Binds
 * the Google `state` round-trip to this browser — the callback refuses any
 * state that does not verify against this cookie's nonce (CSRF / login-fixation
 * guard). Single-use: the callback clears it even on failure.
 */
export const OAUTH_STATE_COOKIE = "pid_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function setOAuthStateCookie(res: Response, config: ConfigService, nonce: string): void {
  res.cookie(OAUTH_STATE_COOKIE, nonce, { ...baseOpts(config), path: REFRESH_PATH, maxAge: OAUTH_STATE_TTL_MS });
}

export function clearOAuthStateCookie(res: Response, config: ConfigService): void {
  res.clearCookie(OAUTH_STATE_COOKIE, clearOpts(config, REFRESH_PATH));
}
