import { BadRequestException, Logger } from "@nestjs/common";
import { Request } from "express";
import { AuthController } from "./auth.controller";
import { OAUTH_STATE_COOKIE } from "../common/cookies";
import { newOAuthNonce, oauthStateSecret, signOAuthState } from "./oauth-state";
import { SsoCodeInvalidError } from "./sso.service";

/** ANT-387: missing/malformed `handle` on GET /v1/auth/pid/available is a 400, not 200 available:false. */
describe("AuthController.pidAvailable (GET /v1/auth/pid/available)", () => {
  const isPidAvailable = jest.fn();
  const controller = new AuthController(
    { isPidAvailable } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const reqWith = (query: unknown): Request => ({ query } as unknown as Request);

  beforeEach(() => isPidAvailable.mockReset());

  it("400s when handle is missing", async () => {
    await expect(controller.pidAvailable(reqWith({}))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("400s when handle is malformed (too short)", async () => {
    await expect(controller.pidAvailable(reqWith({ handle: "ab" }))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("400s when handle is not a string", async () => {
    await expect(controller.pidAvailable(reqWith({ handle: ["ifal"] }))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("delegates normalized handles to the service", async () => {
    isPidAvailable.mockResolvedValue({ available: true, pid: "ifal@pid" });
    await expect(controller.pidAvailable(reqWith({ handle: "IFAL " }))).resolves.toEqual({
      available: true,
      pid: "ifal@pid",
    });
    expect(isPidAvailable).toHaveBeenCalledWith("ifal");
  });

  it("passes taken handles through as 200 available:false", async () => {
    isPidAvailable.mockResolvedValue({ available: false, pid: null });
    await expect(controller.pidAvailable(reqWith({ handle: "ifal" }))).resolves.toEqual({
      available: false,
      pid: null,
    });
  });
});

/** First-party Google callback (no returnTo): the guard binds the state to the
 * wallet origin, so the callback lands on the wallet with the session — no
 * pid_code minted, no allowlist lookup (pre-M3 behavior, M3 CSRF guarantees). */
describe("AuthController.googleCallback first-party (GET /v1/auth/google/callback)", () => {
  const WALLET = "https://sandbox.peridot.id";
  const values: Record<string, string> = {
    API_URL: "https://sandbox-api.peridot.id",
    WALLET_URL: WALLET,
    JWT_ACCESS_SECRET: "test-secret",
  };
  const get = jest.fn((key: string, def?: string) => values[key] ?? def ?? "");
  const issueSession = jest.fn();
  const resolveReturnTo = jest.fn();
  const issue = jest.fn();
  const controller = new AuthController(
    { issueSession } as never,
    {} as never,
    { resolveReturnTo, issue } as never,
    {} as never,
    {} as never,
    {} as never,
    { get } as never,
  );

  beforeEach(() => {
    issueSession.mockReset();
    resolveReturnTo.mockReset();
    issue.mockReset();
  });

  it("lands on the wallet with the session (no pid_code, no allowlist lookup)", async () => {
    const secret = oauthStateSecret(get);
    const nonce = newOAuthNonce();
    const state = signOAuthState({ returnTo: WALLET }, nonce, secret);
    const redirect = jest.fn();
    const req = {
      user: { pid: "ifal@pid" },
      query: { state },
      headers: {},
      cookies: { [OAUTH_STATE_COOKIE]: nonce },
    } as never;
    const res = { redirect, clearCookie: jest.fn() } as never;

    await controller.googleCallback(req, res);

    expect(issueSession).toHaveBeenCalled();
    expect(resolveReturnTo).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(WALLET);
  });
});

/** ANT-693: POST /v1/auth/exchange failures are observable (correlation id +
 * server-side reason) while the public error stays uniform (no oracle). */
describe("AuthController.exchange (POST /v1/auth/exchange)", () => {
  const make = (sso: unknown): AuthController =>
    new AuthController({} as never, {} as never, sso as never, {} as never, {} as never, {} as never, {} as never);

  it("passes successful exchanges through untouched", async () => {
    const payload = { pid: "ifal@pid" };
    const consume = jest.fn(async () => payload);
    const controller = make({ consume });
    await expect(
      controller.exchange({ code: "valid-code-0000000000000000", redirectUri: "https://app.example/cb" } as never),
    ).resolves.toEqual(payload);
    expect(consume).toHaveBeenCalledWith("valid-code-0000000000000000", "https://app.example/cb", undefined, undefined, undefined);
  });

  it("returns a uniform error with correlation id and logs the machine reason", async () => {
    const consume = jest.fn(async () => {
      throw new SsoCodeInvalidError("redirect_mismatch");
    });
    const controller = make({ consume });
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    try {
      await controller.exchange({ code: "valid-code-0000000000000000", redirectUri: "https://evil.example/cb" } as never);
      throw new Error("expected exchange to fail");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body["error"]).toBe("sso_code_invalid");
      expect(String(body["message"])).toMatch(/redirect_uri/);
      expect(typeof body["correlationId"]).toBe("string");
      expect((body["correlationId"] as string).length).toBeGreaterThan(0);
    }

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reason=redirect_mismatch/));
    warn.mockRestore();
  });
});
