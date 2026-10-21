import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";

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

  it("allows writes for unscoped machine tokens (legacy back-compat, logged)", () => {
    const u = guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("POST", "/v1/fiat/transfers/x/confirm"));
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
