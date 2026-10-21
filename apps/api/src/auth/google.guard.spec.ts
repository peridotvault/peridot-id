import { ServiceUnavailableException } from "@nestjs/common";
import { GoogleGuard, isGoogleAuthError } from "./google.guard";
import { OAUTH_STATE_COOKIE } from "../common/cookies";
import { oauthStateSecret, verifyOAuthState } from "./oauth-state";

const OPTS = { clientID: "id", clientSecret: "secret", callbackURL: "http://localhost/cb" };

function configMock() {
  return {
    get: jest.fn((key: string, def?: string) => (key === "JWT_ACCESS_SECRET" ? "test-secret" : (def ?? ""))),
  };
}

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function contextWith(query: Record<string, unknown>, res: unknown) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query }),
      getResponse: () => res,
    }),
  } as never;
}

describe("GoogleGuard.handleRequest", () => {
  it("maps a strategy failure to a retryable marker (never raw provider errors)", async () => {
    const guard = new GoogleGuard(OPTS, configMock() as never);
    const out = await guard.handleRequest(new Error("invalid_grant"), undefined, undefined, undefined as never);

    expect(isGoogleAuthError(out)).toBe(true);
    expect(out).toMatchObject({ authError: "oauth_failed" });
  });

  it("maps a missing user to the same marker", async () => {
    const guard = new GoogleGuard(OPTS, configMock() as never);
    const out = await guard.handleRequest(undefined, undefined, undefined, undefined as never);

    expect(out).toMatchObject({ authError: "oauth_failed" });
  });

  it("maps unconfigured OAuth distinctly", async () => {
    const guard = new GoogleGuard(OPTS, configMock() as never);
    const out = await guard.handleRequest(
      new ServiceUnavailableException("nope"),
      undefined,
      undefined,
      undefined as never,
    );

    expect(out).toMatchObject({ authError: "oauth_not_configured" });
  });

  it("passes a verified identity through untouched", async () => {
    const guard = new GoogleGuard(OPTS, configMock() as never);
    const identity = { pid: "ifal@pid" };

    expect(guard.handleRequest(undefined, identity, undefined, undefined as never)).toBe(identity);
  });
});

describe("GoogleGuard.getAuthenticateOptions (M3 signed state)", () => {
  it("passes through without state when no returnTo is requested", () => {
    const guard = new GoogleGuard(OPTS, configMock() as never);
    const res = resMock();

    const options = guard.getAuthenticateOptions(contextWith({}, res));

    expect(options).toEqual({ prompt: "select_account" });
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("signs the state and binds it to an HttpOnly nonce cookie", () => {
    const config = configMock();
    const guard = new GoogleGuard(OPTS, config as never);
    const res = resMock();

    const options = guard.getAuthenticateOptions(
      contextWith({ returnTo: "https://live2dev.com/auth/callback" }, res),
    );

    expect(typeof options.state).toBe("string");
    // Nonce cookie: HttpOnly, 10-min TTL, auth paths.
    expect(res.cookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: "/v1/auth", maxAge: 10 * 60 * 1000 }),
    );
    const nonce = (res.cookie as jest.Mock).mock.calls[0][1] as string;
    // The state verifies against the cookie nonce BEFORE any decoding — with
    // the same derived key the guard signed with (F1: never the raw JWT secret).
    expect(verifyOAuthState(options.state as string, nonce, oauthStateSecret(config.get))).toEqual({
      returnTo: "https://live2dev.com/auth/callback",
    });
  });

  it("preserves the app binding through the signed envelope", () => {
    const config = configMock();
    const guard = new GoogleGuard(OPTS, config as never);
    const res = resMock();
    const appState = Buffer.from(JSON.stringify({ r: "https://mygame.dev/callback", c: "pidapp_abc" }), "utf8").toString(
      "base64url",
    );

    const options = guard.getAuthenticateOptions(contextWith({ returnTo: appState }, res));

    const nonce = (res.cookie as jest.Mock).mock.calls[0][1] as string;
    expect(verifyOAuthState(options.state as string, nonce, oauthStateSecret(config.get))).toEqual({
      returnTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
    });
  });
});
