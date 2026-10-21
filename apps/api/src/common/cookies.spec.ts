import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  clearScopedAuthCookies,
  setActiveAuthCookies,
  setAuthCookies,
  setScopedAuthCookies,
} from "./cookies";

function configMock(values: Record<string, string>) {
  return {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
  };
}

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

const HTTPS = { API_URL: "https://api.peridot.id", COOKIE_DOMAIN: "" };
const HTTP_LOCAL = { API_URL: "http://localhost:3300", COOKIE_DOMAIN: "localhost" };

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
