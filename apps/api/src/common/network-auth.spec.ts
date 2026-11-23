import type { Request } from "express";
import { mainnetSession, resetMainnetSessionCache, sessionToken } from "./network-auth";

function req(headers: Record<string, string> = {}, cookies: Record<string, string> = {}): Request {
  return { headers, cookies } as unknown as Request;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sessionToken", () => {
  it("prefers the scoped access cookie", () => {
    expect(
      sessionToken(req({ "x-pid-scope": "wallet" }, { pid_access_wallet: "scoped", pid_access: "plain" })),
    ).toBe("scoped");
  });

  it("falls back to the unscoped cookie then Bearer", () => {
    expect(sessionToken(req({}, { pid_access: "plain" }))).toBe("plain");
    expect(sessionToken(req({ authorization: "Bearer tok" }, {}))).toBe("tok");
    expect(sessionToken(req({}, {}))).toBeNull();
  });
});

describe("mainnetSession", () => {
  beforeEach(() => resetMainnetSessionCache());

  it("does nothing off the testnet stack", async () => {
    const fetchImpl = jest.fn();
    expect(
      await mainnetSession(req({}, { pid_access: "tok" }), {
        network: "mainnet",
        baseUrl: "https://api.peridot.id",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null without a session token", async () => {
    expect(await mainnetSession(req(), { network: "testnet", baseUrl: "https://api.peridot.id" })).toBeNull();
  });

  it("introspects against mainnet and caches the result", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ pid: "ifal@pid", scope: "read" }));
    const opts = { network: "testnet", baseUrl: "https://api.peridot.id", fetchImpl: fetchImpl as unknown as typeof fetch };
    const session = await mainnetSession(req({}, { pid_access: "tok" }), opts);
    expect(session).toEqual({ pid: "ifal@pid", scope: "read" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.peridot.id/v1/auth/introspect",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }),
    );
    await mainnetSession(req({}, { pid_access: "tok" }), opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a rejected token or an unreachable mainnet", async () => {
    const rejected = jest.fn(async () => jsonResponse({ statusCode: 401 }, 401));
    expect(
      await mainnetSession(req({}, { pid_access: "tok" }), {
        network: "testnet",
        baseUrl: "https://api.peridot.id",
        fetchImpl: rejected as unknown as typeof fetch,
      }),
    ).toBeNull();
    const down = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await mainnetSession(req({}, { pid_access: "tok2" }), {
        network: "testnet",
        baseUrl: "https://api.peridot.id",
        fetchImpl: down as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});
