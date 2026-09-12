import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AdminService } from "./admin.service";

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
  };
  const chains = { invalidate: jest.fn() };
  const security = { log: jest.fn(async () => undefined) };
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
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.chain.created", expect.anything(), undefined);
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

  it("guards the admin surface end to end (user denied, admin allowed)", async () => {
    const { guard, prisma } = setup();
    const ctx = (id?: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: id ? { identityId: id } : undefined }) }) }) as never;
    prisma.identity.findUnique.mockResolvedValue({ role: "user", status: "active" });
    await expect(guard.canActivate(ctx("pid_user"))).rejects.toThrow(ForbiddenException);
    prisma.identity.findUnique.mockResolvedValue({ role: "admin", status: "active" });
    await expect(guard.canActivate(ctx(IDENTITY))).resolves.toBe(true);
  });
});
