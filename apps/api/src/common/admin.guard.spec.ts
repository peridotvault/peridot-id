import { ForbiddenException } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";

function setup(identity: { role: string; status: string } | null) {
  const prisma = { identity: { findUnique: jest.fn(async () => identity) } };
  return new AdminGuard(prisma as never);
}

function ctx(pid?: string, role?: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: pid ? { pid, ...(role ? { role } : {}) } : undefined }) }),
  } as never;
}

describe("AdminGuard", () => {
  it("denies requests without a user", async () => {
    await expect(setup({ role: "admin", status: "active" }).canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it("denies non-admin roles (fail-closed)", async () => {
    await expect(setup({ role: "user", status: "active" }).canActivate(ctx("pid_1"))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("denies unknown roles and suspended admins", async () => {
    await expect(setup({ role: "superadmin", status: "active" }).canActivate(ctx("pid_1"))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(setup({ role: "admin", status: "suspended" }).canActivate(ctx("pid_1"))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(setup(null).canActivate(ctx("pid_1"))).rejects.toThrow(ForbiddenException);
  });

  it("allows active admins", async () => {
    await expect(setup({ role: "admin", status: "active" }).canActivate(ctx("pid_1"))).resolves.toBe(true);
  });

  it("trusts the mainnet-introspected role when the local row is a testnet shadow", async () => {
    await expect(setup({ role: "user", status: "active" }).canActivate(ctx("pid_1", "admin"))).resolves.toBe(true);
    await expect(setup(null).canActivate(ctx("pid_1", "admin"))).resolves.toBe(true);
    await expect(setup({ role: "user", status: "active" }).canActivate(ctx("pid_1", "user"))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
