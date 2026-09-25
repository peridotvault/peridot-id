import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";

function ctx(method: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ method }) }) } as unknown as ExecutionContext;
}

describe("JwtAuthGuard read-scope", () => {
  const guard = new JwtAuthGuard();

  it("allows GET for read-scoped tokens", () => {
    const u = guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x", scope: "read" }, null, ctx("GET"));
    expect(u).toMatchObject({ pid: "a@pid" });
  });

  it("blocks writes for read-scoped tokens", () => {
    expect(() =>
      guard.handleRequest(null, { pid: "a@pid", scope: "read" }, null, ctx("POST")),
    ).toThrow(ForbiddenException);
  });

  it("allows writes for unscoped machine tokens", () => {
    const u = guard.handleRequest(null, { pid: "a@pid", app: "pidapp_x" }, null, ctx("POST"));
    expect(u).toMatchObject({ pid: "a@pid" });
  });
});
