import { ForbiddenException } from "@nestjs/common";
import { UserTokenGuard } from "./user-token.guard";

function ctx(app?: string) {
  return { switchToHttp: () => ({ getRequest: () => ({ user: app ? { pid: "pid_1", app } : { pid: "pid_1" } }) }) } as never;
}

describe("UserTokenGuard (ANT-233 F1)", () => {
  const guard = new UserTokenGuard();

  it("allows a user session token (no app claim)", () => {
    expect(guard.canActivate(ctx())).toBe(true);
  });

  it("rejects a machine token (app claim set)", () => {
    expect(() => guard.canActivate(ctx("pidapp_x"))).toThrow(ForbiddenException);
  });

  it("rejects a missing user fail-closed", () => {
    const empty = { switchToHttp: () => ({ getRequest: () => ({}) }) } as never;
    expect(() => guard.canActivate(empty)).toThrow(ForbiddenException);
  });
});
