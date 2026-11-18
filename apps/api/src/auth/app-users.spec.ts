import { PidAppsService } from "./apps.service";
import { PidAppsController } from "./apps.controller";

function setup() {
  const at = new Date("2026-11-18T00:00:00Z");
  const prisma = {
    pidApp: { findFirst: jest.fn(async ({ where }) => where.ownerPid === "owner@pid" && where.id === "app-1" ? { clientId: "client-1" } : null) },
    appUser: {
      findMany: jest.fn(async () => [{ pid: "user@pid", appClientId: "client-1", firstLoginAt: at, lastLoginAt: at }]),
      count: jest.fn(async () => 26),
    },
    profile: { findMany: jest.fn(async () => [{ pid: "user@pid", displayName: "User" }]) },
    $transaction: jest.fn(async (queries) => Promise.all(queries)),
  };
  return { prisma, service: new PidAppsService(prisma as never) };
}

describe("app user directory", () => {
  it("rejects another owner before querying users or profiles", async () => {
    const { service, prisma } = setup();
    await expect(service.users("stranger@pid", "app-1")).rejects.toThrow("App not found");
    expect(prisma.appUser.findMany).not.toHaveBeenCalled();
    expect(prisma.appUser.count).not.toHaveBeenCalled();
    expect(prisma.profile.findMany).not.toHaveBeenCalled();
  });
  it("scopes search/count to the owned app and returns only directory fields", async () => {
    const { service, prisma } = setup();
    const result = await service.users("owner@pid", "app-1", " USER ", 2);
    expect(prisma.appUser.findMany).toHaveBeenCalledWith({
      where: { appClientId: "client-1", pid: { contains: "user" } }, orderBy: { pid: "asc" }, skip: 25, take: 25,
    });
    expect(prisma.appUser.count).toHaveBeenCalledWith({ where: { appClientId: "client-1", pid: { contains: "user" } } });
    expect(prisma.profile.findMany).toHaveBeenCalledWith({ where: { pid: { in: ["user@pid"] } }, select: { pid: true, displayName: true } });
    expect(Object.keys(result.users[0]).sort()).toEqual(["displayName", "firstLoginAt", "lastLoginAt", "pid"]);
    expect(result).toMatchObject({ total: 26, page: 2, pageSize: 25 });
  });
  it.each([0, -1, 1.5, NaN, 100001])("rejects invalid page %s", async page => {
    const { service } = setup();
    await expect(service.users("owner@pid", "app-1", "", page)).rejects.toThrow("Invalid");
  });
  it("rejects oversized and malformed query values", async () => {
    const { service } = setup();
    await expect(service.users("owner@pid", "app-1", "x".repeat(101))).rejects.toThrow("Invalid");
    const controller = new PidAppsController(service, {} as never);
    expect(() => controller.users({ pid: "owner@pid" } as never, "app-1", [] as never)).toThrow("Invalid");
    expect(() => controller.users({ pid: "owner@pid" } as never, "app-1", "", "1.5")).toThrow("Invalid");
  });
});
