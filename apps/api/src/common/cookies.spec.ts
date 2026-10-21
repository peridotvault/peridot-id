import {
  ACCESS_COOKIE,
  CLAIM_COOKIE,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  accountRefreshCookieName,
  clearAccountRefreshCookie,
  clearAllAccountRefreshCookies,
  clearAllScopedAuthCookies,
  clearAuthCookies,
  clearClaimCookie,
  clearOAuthStateCookie,
  clearScopedAuthCookies,
  normalizeScope,
  scopeAccessCookie,
  scopeRefreshCookie,
  setAccountRefreshCookie,
  setActiveAuthCookies,
  setAuthCookies,
  setClaimCookie,
  setOAuthStateCookie,
  setScopedAuthCookies,
} from "./cookies";

function configMock(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    COOKIE_SECURE: "true",
    COOKIE_DOMAIN: "pid.peridotvault.com",
    COOKIE_SAMESITE: "lax",
    API_URL: "https://api.pid.peridotvault.com",
    ...overrides,
  };
  return { get: jest.fn((key: string, def?: string) => values[key] ?? def ?? "") } as never;
}

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

/** Set-cookie options recorded for `name` (the last set wins). */
function setOpts(res: { cookie: jest.Mock }, name: string): Record<string, unknown> {
  const calls = res.cookie.mock.calls.filter(([n]) => n === name);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as Record<string, unknown>;
}

/** Clear-cookie options recorded for `name` (the last clear wins). */
function clearOpts(res: { clearCookie: jest.Mock }, name: string): Record<string, unknown> {
  const calls = res.clearCookie.mock.calls.filter(([n]) => n === name);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("cookies clear-mirror-set (M5)", () => {
  it("clearAuthCookies mirrors the set flags (secure/sameSite/httpOnly/domain/path)", () => {
    const config = configMock();
    const res = resMock();
    setAuthCookies(res as never, config, "access", "refresh", "ifal@pid");
    clearAuthCookies(res as never, config);

    const setAccess = setOpts(res, ACCESS_COOKIE);
    const clearAccess = clearOpts(res, ACCESS_COOKIE);
    expect(clearAccess).toEqual({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com", path: "/" });
    expect(clearAccess).toMatchObject({ httpOnly: setAccess.httpOnly, sameSite: setAccess.sameSite, secure: setAccess.secure, domain: setAccess.domain });
    expect(clearAccess.path).toBe(setAccess.path);

    const setRefresh = setOpts(res, REFRESH_COOKIE);
    const clearRefresh = clearOpts(res, REFRESH_COOKIE);
    expect(clearRefresh).toEqual({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com", path: "/v1/auth" });
    expect(clearRefresh.path).toBe(setRefresh.path);
  });

  it("scoped clears mirror the scoped sets", () => {
    const config = configMock();
    const res = resMock();
    setScopedAuthCookies(res as never, config, "web", "a", "r");
    clearScopedAuthCookies(res as never, config, "web");

    expect(clearOpts(res, scopeAccessCookie("web"))).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com", path: "/" }),
    );
    expect(clearOpts(res, scopeRefreshCookie("web"))).toEqual(
      expect.objectContaining({ httpOnly: true, path: "/v1/auth" }),
    );
  });

  it("account + claim clears mirror their sets", () => {
    const config = configMock();
    const res = resMock();
    setAccountRefreshCookie(res as never, config, "ifal@pid", "r");
    clearAccountRefreshCookie(res as never, config, "ifal@pid");
    const name = accountRefreshCookieName("ifal@pid");
    expect(clearOpts(res, name)).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com", path: "/v1/auth" }),
    );

    setClaimCookie(res as never, config, "ct_x");
    clearClaimCookie(res as never, config);
    expect(clearOpts(res, CLAIM_COOKIE)).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, path: "/v1/auth" }),
    );
  });

  it("oauth state set/clear mirror each other (M3 cookie)", () => {
    const config = configMock();
    const res = resMock();
    setOAuthStateCookie(res as never, config, "nonce");
    clearOAuthStateCookie(res as never, config);
    expect(clearOpts(res, OAUTH_STATE_COOKIE)).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, path: "/v1/auth" }),
    );
  });

  it("clearAllScopedAuthCookies clears every scope present and nothing else", () => {
    const config = configMock();
    const res = resMock();
    const cookies = {
      [scopeAccessCookie("web")]: "a",
      [scopeRefreshCookie("web")]: "r",
      [scopeRefreshCookie("embed")]: "r2",
      [ACCESS_COOKIE]: "a0",
      [REFRESH_COOKIE]: "r0",
      pid_refresh__deadbeef: "linked",
      unrelated: "x",
    };

    const scopes = clearAllScopedAuthCookies(res as never, config, cookies);

    expect(scopes.sort()).toEqual(["embed", "web"]);
    const cleared = (res.clearCookie as jest.Mock).mock.calls.map(([n]) => n);
    expect(cleared).toEqual(
      expect.arrayContaining([
        scopeAccessCookie("web"),
        scopeRefreshCookie("web"),
        scopeAccessCookie("embed"),
        scopeRefreshCookie("embed"),
      ]),
    );
    expect(cleared).not.toContain(ACCESS_COOKIE);
    expect(cleared).not.toContain("unrelated");
    expect(cleared).not.toContain("pid_refresh__deadbeef");
  });

  it("clearAllAccountRefreshCookies clears every linked-account cookie by name", () => {
    const config = configMock();
    const res = resMock();
    const cookies = {
      [accountRefreshCookieName("ifal@pid")]: "r1",
      [accountRefreshCookieName("kupuakz@pid")]: "r2",
      [REFRESH_COOKIE]: "r0",
    };

    const names = clearAllAccountRefreshCookies(res as never, config, cookies);

    expect(names.sort()).toEqual(
      [accountRefreshCookieName("ifal@pid"), accountRefreshCookieName("kupuakz@pid")].sort(),
    );
    const cleared = (res.clearCookie as jest.Mock).mock.calls.map(([n]) => n);
    expect(cleared).toEqual(expect.arrayContaining(names));
    expect(cleared).not.toContain(REFRESH_COOKIE);
  });
});

const HTTPS = { API_URL: "https://api.peridot.id", COOKIE_DOMAIN: "", COOKIE_SECURE: "" };
const HTTP_LOCAL = { API_URL: "http://localhost:3300", COOKIE_DOMAIN: "localhost", COOKIE_SECURE: "" };

describe("cookie transport hardening (ANT-228)", () => {
  it("fails closed on transport: Secure defaults true behind https", () => {
    const res = resMock();
    setAuthCookies(res as never, configMock(HTTPS) as never, "a", "r", undefined);
    expect(res.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ secure: true }));
    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, "r", expect.objectContaining({ secure: true }));
  });

  it("keeps localhost dev working (http origin → Secure false)", () => {
    const res = resMock();
    setAuthCookies(res as never, configMock(HTTP_LOCAL) as never, "a", "r", undefined);
    expect(res.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ secure: false }));
  });

  it("honors an explicit COOKIE_SECURE either way", () => {
    const forceOn = resMock();
    setAuthCookies(forceOn as never, configMock({ ...HTTP_LOCAL, COOKIE_SECURE: "true" }) as never, "a", "r", undefined);
    expect(forceOn.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ secure: true }));

    const forceOff = resMock();
    setAuthCookies(forceOff as never, configMock({ ...HTTPS, COOKIE_SECURE: "false" }) as never, "a", "r", undefined);
    expect(forceOff.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ secure: false }));
  });

  it("pins SameSite to Lax/Strict: None throws without a CSRF guard", () => {
    const res = resMock();
    expect(() =>
      setAuthCookies(res as never, configMock({ ...HTTPS, COOKIE_SAMESITE: "none" }) as never, "a", "r", undefined),
    ).toThrow(/CSRF/);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("defaults unknown SameSite values to Lax (never None)", () => {
    const res = resMock();
    setAuthCookies(res as never, configMock({ ...HTTPS, COOKIE_SAMESITE: "bogus" }) as never, "a", "r", undefined);
    expect(res.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ sameSite: "lax" }));
  });

  it("restricts the access cookie to Path=/ and clears with the same path", () => {
    const res = resMock();
    setAuthCookies(res as never, configMock(HTTPS) as never, "a", "r", undefined);
    expect(res.cookie).toHaveBeenCalledWith(
      ACCESS_COOKIE,
      "a",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );
    // Refresh stays least-privilege: only sent on /v1/auth.
    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, "r", expect.objectContaining({ path: "/v1/auth" }));

    const clear = resMock();
    clearAuthCookies(clear as never, configMock(HTTPS) as never);
    expect(clear.clearCookie).toHaveBeenCalledWith(ACCESS_COOKIE, expect.objectContaining({ path: "/" }));
    expect(clear.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.objectContaining({ path: "/v1/auth" }));
  });

  it("applies the same Path discipline to scoped + rotated cookies", () => {
    const res = resMock();
    setActiveAuthCookies(res as never, configMock(HTTPS) as never, "a", "r");
    expect(res.cookie).toHaveBeenCalledWith(ACCESS_COOKIE, "a", expect.objectContaining({ path: "/" }));

    const scoped = resMock();
    setScopedAuthCookies(scoped as never, configMock(HTTPS) as never, "ws", "a", "r");
    expect(scoped.cookie).toHaveBeenCalledWith("pid_access_ws", "a", expect.objectContaining({ path: "/" }));
    expect(scoped.cookie).toHaveBeenCalledWith("pid_refresh_ws", "r", expect.objectContaining({ path: "/v1/auth" }));

    const clear = resMock();
    clearScopedAuthCookies(clear as never, configMock(HTTPS) as never, "ws");
    expect(clear.clearCookie).toHaveBeenCalledWith("pid_access_ws", expect.objectContaining({ path: "/" }));
    expect(clear.clearCookie).toHaveBeenCalledWith("pid_refresh_ws", expect.objectContaining({ path: "/v1/auth" }));
  });
});

describe("normalizeScope (ANT-284)", () => {
  it("accepts lowercase alnum scopes", () => {
    expect(normalizeScope("web")).toBe("web");
    expect(normalizeScope("embed")).toBe("embed");
    expect(normalizeScope("WS")).toBe("ws");
    expect(normalizeScope(["web"])).toBe("web");
  });

  it("rejects leading-underscore scopes (account-cookie namespace collision)", () => {
    expect(normalizeScope("_evil")).toBeNull();
    expect(normalizeScope("_")).toBeNull();
    expect(normalizeScope("")).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope("has space")).toBeNull();
    expect(normalizeScope("_upper_ok")).toBeNull();
  });
});
