import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { resetMainnetSessionCache } from "./network-auth";

function ctx(method: string, path = "/"): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ method, path }) }) } as unknown as ExecutionContext;
}

describe("JwtAuthGuard read-scope", () => {
  const guard = new JwtAuthGuard();

  it("allows GET for read-scoped tokens", () => {
    const u = guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x", scope: "read" }, null, ctx("GET"));
    expect(u).toMatchObject({ pid: "a@pid" });
  });

  it("blocks writes for read-scoped tokens", () => {
    expect(() =>
      guard.handleRequest(null, { pid: "a@pid", scope: "read" }, null, ctx("POST", "/v1/fiat/transfers/x/confirm")),
    ).toThrow(ForbiddenException);
  });

  it("allows deposit sync for read-scoped tokens (safe self-corroboration)", () => {
    const u = guard.handleRequest(
      null,
      { pid: "a@pid", scope: "read" },
      null,
      ctx("POST", "/v1/fiat/deposits/abc-123/sync"),
    );
    expect(u).toMatchObject({ pid: "a@pid" });
  });

  it("rejects unscoped legacy machine tokens on transfers (ANT-344 H3: migration complete)", () => {
    expect(() =>
      guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("POST", "/v1/fiat/transfers/x/confirm")),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("POST", "/v1/fiat/transfers/inquiry")),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("POST", "/v1/fiat/transfers/x/cancel")),
    ).toThrow(ForbiddenException);
  });

  it("still allows unscoped machine tokens on reads (no transfer power needed)", () => {
    const u = guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("GET", "/v1/fiat/balance"));
    expect(u).toMatchObject({ pid: "a@pid" });
  });

  it("allows fiat:transfer-scoped machine tokens on POST /v1/fiat/transfers/* (ANT-286b)", () => {
    const u = guard.handleRequest(
      null,
      { pid: "a@pid", app: "pidapp_x", scope: "fiat:transfer" },
      null,
      ctx("POST", "/v1/fiat/transfers/inquiry"),
    );
    expect(u).toMatchObject({ pid: "a@pid", scope: "fiat:transfer" });
  });

  it("blocks mis-scoped machine tokens on POST /v1/fiat/transfers/* (fail closed)", () => {
    expect(() =>
      guard.handleRequest(
        null,
        { pid: "a@pid", app: "pidapp_x", scope: "other" },
        null,
        ctx("POST", "/v1/fiat/transfers/inquiry"),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.handleRequest(
        null,
        { pid: "a@pid", app: "pidapp_x", scope: "read" },
        null,
        ctx("POST", "/v1/fiat/transfers/abc/confirm"),
      ),
    ).toThrow(ForbiddenException);
  });
});

describe("JwtAuthGuard on the testnet stack", () => {
  const config = {
    get: (key: string, def?: string) =>
      key === "PID_NETWORK" ? "testnet" : key === "API_URL" ? "https://sandbox-api.peridot.id" : def,
  };
  const guard = new JwtAuthGuard(config as never);

  function reqCtx(cookie = "tok"): { ctx: ExecutionContext; req: { method: string; path: string; headers: Record<string, string>; cookies: Record<string, string>; user?: unknown } } {
    const req = { method: "GET", path: "/v1/chains", headers: {} as Record<string, string>, cookies: { pid_access: cookie } };
    return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext, req };
  }

  beforeEach(() => {
    resetMainnetSessionCache();
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ pid: "ifal@pid" }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
  });

  it("authenticates by introspecting the mainnet API", async () => {
    const { ctx, req } = reqCtx();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ pid: "ifal@pid" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.peridot.id/v1/auth/introspect",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }),
    );
  });

  it("fails closed when mainnet rejects the session", async () => {
    globalThis.fetch = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const { ctx } = reqCtx();
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
