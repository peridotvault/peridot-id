import { ForbiddenException } from "@nestjs/common";
import {
  CsrfOriginGuard,
  __resetCsrfAppOriginsForTests,
  extractRequestOrigin,
  hasSessionCookie,
} from "./csrf-origin.guard";
import { APP_ORIGINS_TTL_MS } from "./cors";

function configFor(staticOrigins: string[]) {
  return {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === "CORS_ORIGINS") return "";
      if (key === "API_URL") return "https://api.peridot.id";
      if (key === "WALLET_URL") return "https://peridot.id";
      if (key === "DASHBOARD_URL") return "https://dashboard.peridot.id";
      if (key === "DOCS_URL") return "https://docs.peridot.id";
      return def;
    }),
  } as never;
}

function ctx(method: string, opts: { cookies?: Record<string, string>; origin?: string; referer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, path: "/v1/auth/refresh", headers, cookies: opts.cookies ?? {} }),
    }),
  } as never;
}

describe("CSRF Origin guard (ANT-367)", () => {
  beforeEach(() => {
    __resetCsrfAppOriginsForTests();
    jest.clearAllMocks();
  });

  it("detects session cookies by pid_ prefix", () => {
    expect(hasSessionCookie({ pid_access: "x" })).toBe(true);
    expect(hasSessionCookie({ pid_access_workspace: "x" })).toBe(true);
    expect(hasSessionCookie({ pid_refresh: "x" })).toBe(true);
    expect(hasSessionCookie({ pid_claim: "x" })).toBe(true);
    expect(hasSessionCookie({})).toBe(false);
    expect(hasSessionCookie(undefined)).toBe(false);
    expect(hasSessionCookie({ session: "x" })).toBe(false);
  });

  it("extracts Origin, falling back to Referer origin", () => {
    expect(extractRequestOrigin({ headers: { origin: "https://peridot.id/" } } as never)).toBe(
      "https://peridot.id",
    );
    expect(
      extractRequestOrigin({ headers: { referer: "https://dashboard.peridot.id/app?x=1" } } as never),
    ).toBe("https://dashboard.peridot.id");
    expect(extractRequestOrigin({ headers: {} } as never)).toBeUndefined();
    expect(extractRequestOrigin({ headers: { referer: "not-a-url" } } as never)).toBeUndefined();
  });

  it("allows allowlisted first-party Origin with cookie (POST passes)", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(
      guard.canActivate(ctx("POST", { cookies: { pid_access: "jwt" }, origin: "https://peridot.id" })),
    ).resolves.toBe(true);
  });

  it("rejects cross-site Origin with cookie (403 fail-closed)", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(
      guard.canActivate(ctx("POST", { cookies: { pid_access: "jwt" }, origin: "https://evil.com" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects missing Origin with cookie (403 fail-closed)", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(guard.canActivate(ctx("POST", { cookies: { pid_access: "jwt" } }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("allows missing Origin with Bearer only (no cookie → unaffected)", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(guard.canActivate(ctx("POST", { cookies: {} }))).resolves.toBe(true);
  });

  it("allows Referer fallback when Origin absent but allowlisted", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(
      guard.canActivate(
        ctx("POST", { cookies: { pid_refresh: "jwt" }, referer: "https://dashboard.peridot.id/login" }),
      ),
    ).resolves.toBe(true);
  });

  it("allows app-registered origin (verified per-app allowlist)", async () => {
    const findMany = jest.fn().mockResolvedValue([{ allowedOrigins: ["https://mygame.dev"] }]);
    const prisma = { pidApp: { findMany } } as unknown as import("../prisma/prisma.service").PrismaService;
    const guard = new CsrfOriginGuard(configFor([]), prisma);
    await expect(
      guard.canActivate(ctx("POST", { cookies: { pid_access_shop: "jwt" }, origin: "https://mygame.dev" })),
    ).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("caches app origins within the TTL (no N+1 per request)", async () => {
    const findMany = jest.fn().mockResolvedValue([{ allowedOrigins: ["https://mygame.dev"] }]);
    const prisma = { pidApp: { findMany } } as unknown as import("../prisma/prisma.service").PrismaService;
    const guard = new CsrfOriginGuard(configFor([]), prisma);
    const req = { cookies: { pid_access: "jwt" }, origin: "https://mygame.dev" };
    await expect(guard.canActivate(ctx("POST", req))).resolves.toBe(true);
    await expect(guard.canActivate(ctx("POST", req))).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(APP_ORIGINS_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("leaves GET + HEAD unaffected even with cross-site Origin + cookie", async () => {
    const guard = new CsrfOriginGuard(configFor([]));
    await expect(
      guard.canActivate(ctx("GET", { cookies: { pid_access: "jwt" }, origin: "https://evil.com" })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(ctx("HEAD", { cookies: { pid_access: "jwt" }, origin: "https://evil.com" })),
    ).resolves.toBe(true);
  });

  it("keeps SameSite Lax posture (does not switch cookies to None)", async () => {
    const cookies = await import("./cookies");
    const config = { get: jest.fn((k: string, d?: unknown) => (k === "COOKIE_SAMESITE" ? "lax" : d)) } as never;
    const res = { cookie: jest.fn() } as unknown as import("express").Response;
    cookies.setAuthCookies(res, config, "a", "r");
    const opts = (res.cookie as unknown as jest.Mock).mock.calls[0][2] as { sameSite: string };
    expect(opts.sameSite).not.toBe("none");
  });
});
