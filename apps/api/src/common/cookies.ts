import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import ms from "ms";

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

function baseOpts(config: ConfigService): Record<string, unknown> {
  const secure = config.get<string>("COOKIE_SECURE", "false") === "true";
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const sameSite = config.get<string>("COOKIE_SAMESITE", "lax") as "lax" | "strict" | "none";
  const opts: Record<string, unknown> = { httpOnly: true, sameSite, secure };
  // Omitting `domain` for localhost avoids a known browser cookie-rejection gotcha.
  if (domain && domain !== "localhost") opts.domain = domain;
  return opts;
}

export function setAuthCookies(res: Response, config: ConfigService, access: string, refresh: string, pid?: string): void {
  const opts = baseOpts(config);
  res.cookie(ACCESS_COOKIE, access, { ...opts, maxAge: ms(config.get<string>("ACCESS_TOKEN_TTL", "15m")) });
  res.cookie(REFRESH_COOKIE, refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")) });
  // Remember this identity so the wallet can switch back to it without a re-login.
  if (pid) setAccountRefreshCookie(res, config, pid, refresh);
}

/** Rotate only the active identity's cookies (used when switching accounts). */
export function setActiveAuthCookies(res: Response, config: ConfigService, access: string, refresh: string): void {
  const opts = baseOpts(config);
  res.cookie(ACCESS_COOKIE, access, { ...opts, maxAge: ms(config.get<string>("ACCESS_TOKEN_TTL", "15m")) });
  res.cookie(REFRESH_COOKIE, refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")) });
}

export function setAccountRefreshCookie(res: Response, config: ConfigService, pid: string, refresh: string): void {
  const opts = baseOpts(config);
  res.cookie(accountRefreshCookieName(pid), refresh, {
    ...opts,
    path: REFRESH_PATH,
    maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")),
  });
}

export function clearAccountRefreshCookie(res: Response, config: ConfigService, pid: string): void {
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const opts: Record<string, unknown> = { path: REFRESH_PATH };
  if (domain && domain !== "localhost") opts.domain = domain;
  res.clearCookie(accountRefreshCookieName(pid), opts);
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
  res.cookie(scopeAccessCookie(scope), access, { ...opts, maxAge: ms(config.get<string>("ACCESS_TOKEN_TTL", "15m")) });
  res.cookie(scopeRefreshCookie(scope), refresh, { ...opts, path: REFRESH_PATH, maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")) });
}

export function clearScopedAuthCookies(res: Response, config: ConfigService, scope: string): void {
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const opts: Record<string, unknown> = {};
  if (domain && domain !== "localhost") opts.domain = domain;
  res.clearCookie(scopeAccessCookie(scope), opts);
  res.clearCookie(scopeRefreshCookie(scope), { ...opts, path: REFRESH_PATH });
}

export function clearAuthCookies(res: Response, config: ConfigService): void {
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const opts: Record<string, unknown> = {};
  if (domain && domain !== "localhost") opts.domain = domain;
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: REFRESH_PATH });
}

/** Pending-claim ticket cookie (opaque ticket id, 10 min, auth paths only). */
export function setClaimCookie(res: Response, config: ConfigService, ticketId: string): void {
  const secure = config.get<string>("COOKIE_SECURE", "false") === "true";
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const sameSite = config.get<string>("COOKIE_SAMESITE", "lax") as "lax" | "strict" | "none";
  const opts: Record<string, unknown> = { httpOnly: true, sameSite, secure, path: REFRESH_PATH, maxAge: CLAIM_TTL_MS };
  if (domain && domain !== "localhost") opts.domain = domain;
  res.cookie(CLAIM_COOKIE, ticketId, opts);
}

export function clearClaimCookie(res: Response, config: ConfigService): void {
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const opts: Record<string, unknown> = { path: REFRESH_PATH };
  if (domain && domain !== "localhost") opts.domain = domain;
  res.clearCookie(CLAIM_COOKIE, opts);
}
