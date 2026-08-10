import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WalletService } from "./wallet.service";

function prismaMock() {
  const mocks: Record<string, unknown> = {
    wallet: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(
        async (args: { data: { identityId: string; chain: string; address: string }; select: unknown }) => ({
          id: "wallet-1",
          ...args.data,
        }),
      ),
    },
  };
  return mocks as any;
}

function setup() {
  const prisma = prismaMock();
  const service = new WalletService(prisma as never);
  return { service, prisma };
}

describe("WalletService", () => {
  it("getMe returns the wallet for the authenticated PID", async () => {
    const { service, prisma } = setup();
    const row = {
      id: "wallet-1",
      identityId: "pid_01HASH",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: new Date(),
    };
    prisma.wallet.findUnique.mockResolvedValue(row);

    const wallet = await service.getMe("pid_01HASH");

    expect(wallet).toEqual(row);
    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
      where: { identityId: "pid_01HASH" },
      select: expect.objectContaining({ address: true, chain: true, status: true }),
    });
  });

  it("getMe throws NotFound when the PID has no wallet", async () => {
    const { service } = setup();

    await expect(service.getMe("pid_01HASH")).rejects.toThrow(NotFoundException);
  });

  it("create persists a solana wallet for the token's PID", async () => {
    const { service, prisma } = setup();

    const wallet = await service.create("pid_01HASH", "addr-solana");

    expect(wallet.id).toBe("wallet-1");
    expect(prisma.wallet.create).toHaveBeenCalledWith({
      data: { identityId: "pid_01HASH", chain: "solana", address: "addr-solana" },
      select: expect.objectContaining({ address: true }),
    });
  });

  it("create returns the existing wallet instead of creating a duplicate", async () => {
    const { service, prisma } = setup();
    const row = { id: "wallet-1", chain: "solana", address: "addr-1", status: "active", createdAt: new Date() };
    prisma.wallet.findUnique.mockResolvedValue(row);

    const wallet = await service.create("pid_01HASH", "addr-2");

    expect(wallet).toEqual(row);
    expect(prisma.wallet.create).not.toHaveBeenCalled();
  });

  it("create returns the existing wallet when a concurrent duplicate hits the unique index", async () => {
    const { service, prisma } = setup();
    const row = { id: "wallet-1", chain: "solana", address: "addr-1", status: "active", createdAt: new Date() };
    prisma.wallet.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row);
    prisma.wallet.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const wallet = await service.create("pid_01HASH", "addr-1");

    expect(wallet).toEqual(row);
    expect(prisma.wallet.create).toHaveBeenCalledTimes(1);
  });
});
