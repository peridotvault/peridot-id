import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import ms from "ms";

export const ACCESS_COOKIE = "pid_access";
export const REFRESH_COOKIE = "pid_refresh";
export const CLAIM_COOKIE = "pid_claim";
const REFRESH_PATH = "/v1/auth";
const CLAIM_TTL_MS = 10 * 60 * 1000;

export function setAuthCookies(res: Response, config: ConfigService, access: string, refresh: string): void {
  const secure = config.get<string>("COOKIE_SECURE", "false") === "true";
  const domain = config.get<string>("COOKIE_DOMAIN", "");
  const sameSite = config.get<string>("COOKIE_SAMESITE", "lax") as "lax" | "strict" | "none";
  const common: Record<string, unknown> = { httpOnly: true, sameSite, secure };
  // Omitting `domain` for localhost avoids a known browser cookie-rejection gotcha.
  if (domain && domain !== "localhost") common.domain = domain;
  res.cookie(ACCESS_COOKIE, access, { ...common, maxAge: ms(config.get<string>("ACCESS_TOKEN_TTL", "15m")) });
  res.cookie(REFRESH_COOKIE, refresh, { ...common, path: REFRESH_PATH, maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")) });
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
