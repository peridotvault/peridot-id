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
  scopeAccessCookie,
  scopeRefreshCookie,
  setAccountRefreshCookie,
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
    expect(clearAccess).toEqual({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com" });
    expect(clearAccess).toMatchObject({ httpOnly: setAccess.httpOnly, sameSite: setAccess.sameSite, secure: setAccess.secure, domain: setAccess.domain });

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
      expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, domain: "pid.peridotvault.com" }),
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
