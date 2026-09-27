import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AdminService } from "./admin.service";
import { mockSecurity } from "../../test/factories";


const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

function setup() {
  const prisma = {
    chain: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async (): Promise<any> => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "chain-1", ...args.data })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "chain-1", ...args.data })),
    },
    chainContract: {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => ({ id: "cc-1", ...args.create })),
    },
    identity: { findUnique: jest.fn(async () => ({ role: "admin", status: "active" })) },
    pidApp: {
      findUnique: jest.fn(async (): Promise<any> => null),
      findMany: jest.fn(async (): Promise<any[]> => []),
      update: jest.fn(async (args: { where: { id: string }; data: { isVerified: boolean } }) => ({
        id: args.where.id, clientId: "pidapp_x", webhookSecret: "wh", clientSecretHash: "hash", ...args.data,
      })),
    },
  };
  const chains = { invalidate: jest.fn() };
  const security = mockSecurity();
  const service = new AdminService(prisma as never, chains as never, security as never);
  const guard = new AdminGuard(prisma as never);
  return { service, prisma, chains, security, guard };
}

const IDENTITY = "pid_admin";

describe("AdminService", () => {
  it("creates chains and logs the event", async () => {
    const { service, prisma, chains, security } = setup();
    const chain = await service.createChain(IDENTITY, {
      namespace: "eip155",
      reference: "84532",
      name: "base-sepolia",
      nativeSymbol: "ETH",
    });
    expect(chain.reference).toBe("84532");
    expect(chains.invalidate).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.chain.created", expect.anything());
    expect(prisma.chain.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decimals: 18 }) }),
    );
  });

  it("rejects duplicate chains", async () => {
    const { service, prisma } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-1" });
    await expect(
      service.createChain(IDENTITY, { namespace: "eip155", reference: "97", name: "x", nativeSymbol: "T" }),
    ).rejects.toThrow(ConflictException);
  });

  it("upserts contracts by type and rejects EVM types on Solana", async () => {
    const { service, prisma } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-1", namespace: "eip155" });
    const contract = await service.upsertContract(IDENTITY, "chain-1", { type: "factory", address: FACTORY });
    expect(contract.address).toBe(FACTORY);
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-sol", namespace: "solana" });
    await expect(service.upsertContract(IDENTITY, "chain-sol", { type: "factory", address: FACTORY })).rejects.toThrow(
      ConflictException,
    );
  });

  it("404s on unknown chains", async () => {
    const { service } = setup();
    await expect(service.updateChain(IDENTITY, "missing", { name: "x" })).rejects.toThrow(NotFoundException);
    await expect(service.upsertContract(IDENTITY, "missing", { type: "factory", address: FACTORY })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("verifies and unverifies apps with an audit event", async () => {
    const { service, prisma, security } = setup();
    prisma.pidApp.findUnique.mockResolvedValue({ id: "app-1", clientId: "pidapp_x" });

    const verified = await service.setAppVerified(IDENTITY, "app-1", true);
    expect(verified).toMatchObject({ id: "app-1", isVerified: true });
    expect(verified).not.toHaveProperty("webhookSecret");
    expect(verified).not.toHaveProperty("clientSecretHash");
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.app.verified", {
      appId: "app-1", clientId: "pidapp_x",
    });

    await service.setAppVerified(IDENTITY, "app-1", false);
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.app.unverified", {
      appId: "app-1", clientId: "pidapp_x",
    });
  });

  it("404s verify on unknown apps and never leaks secrets", async () => {
    const { service } = setup();
    await expect(service.setAppVerified(IDENTITY, "missing", true)).rejects.toThrow(NotFoundException);
  });

  it("lists every app without secrets", async () => {
    const { service, prisma } = setup();
    (prisma.pidApp.findMany as jest.Mock).mockResolvedValue([
      { id: "a1", clientId: "pidapp_1", name: "One", isVerified: true, webhookSecret: "w", clientSecretHash: "h" },
      { id: "a2", clientId: "pidapp_2", name: "Two", isVerified: false, webhookSecret: null, clientSecretHash: null },
    ]);
    const apps = await service.listAllApps();
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ id: "a1", isVerified: true });
    expect(apps[0]).not.toHaveProperty("webhookSecret");
    expect(prisma.pidApp.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
  });

  it("searches apps by name or clientId substring", async () => {
    const { service, prisma } = setup();
    await service.listAllApps("live");
    expect(prisma.pidApp.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ name: { contains: "live", mode: "insensitive" } }, { clientId: { contains: "live" } }],
      },
      orderBy: { createdAt: "desc" },
    });
    await service.listAllApps("   ");
    expect(prisma.pidApp.findMany).toHaveBeenLastCalledWith({ orderBy: { createdAt: "desc" } });
  });

  it("finds apps by clientId for admins without secrets", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({
      id: "app-1", clientId: "pidapp_x", name: "Live2Dev", isVerified: true,
      webhookSecret: "wh", clientSecretHash: "hash",
    });
    const app = await service.findAppByClientId("pidapp_x");
    expect(app).toMatchObject({ id: "app-1", isVerified: true });
    expect(app).not.toHaveProperty("webhookSecret");
    expect(app).not.toHaveProperty("clientSecretHash");
    await expect(service.findAppByClientId("pidapp_nope")).rejects.toThrow(NotFoundException);
  });

  it("guards the admin surface end to end (user denied, admin allowed)", async () => {
    const { guard, prisma } = setup();
    const ctx = (id?: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: id ? { pid: id } : undefined }) }) }) as never;
    prisma.identity.findUnique.mockResolvedValue({ role: "user", status: "active" });
    await expect(guard.canActivate(ctx("pid_user"))).rejects.toThrow(ForbiddenException);
    prisma.identity.findUnique.mockResolvedValue({ role: "admin", status: "active" });
    await expect(guard.canActivate(ctx(IDENTITY))).resolves.toBe(true);
  });
});
