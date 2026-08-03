import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import ms from "ms";

export const ACCESS_COOKIE = "peridot_access";
export const REFRESH_COOKIE = "peridot_refresh";
const REFRESH_PATH = "/v1/auth";

export function setAuthCookies(res: Response, config: ConfigService, access: string, refresh: string): void {
  const secure = config.get<string>("COOKIE_SECURE", "false") === "true";
  const domain = config.get<string>("COOKIE_DOMAIN", "localhost");
  const common = { httpOnly: true, sameSite: "lax" as const, secure, domain };
  res.cookie(ACCESS_COOKIE, access, { ...common, maxAge: ms(config.get<string>("ACCESS_TOKEN_TTL", "15m")) });
  res.cookie(REFRESH_COOKIE, refresh, { ...common, path: REFRESH_PATH, maxAge: ms(config.get<string>("REFRESH_TOKEN_TTL", "30d")) });
}

export function clearAuthCookies(res: Response, config: ConfigService): void {
  const domain = config.get<string>("COOKIE_DOMAIN", "localhost");
  res.clearCookie(ACCESS_COOKIE, { domain });
  res.clearCookie(REFRESH_COOKIE, { domain, path: REFRESH_PATH });
}
