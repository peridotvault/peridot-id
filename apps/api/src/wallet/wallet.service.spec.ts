import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WalletService } from "./wallet.service";

const LINKED = "linked_address";

function accountRow(identityId: string, withLinked: boolean, address: string) {
  return {
    id: `acc-${identityId}`,
    identityId,
    status: "active",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    chainAccounts: withLinked
      ? [
          {
            id: `w-${identityId}`,
            accountId: `acc-${identityId}`,
            chainNamespace: "solana",
            chainReference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
            address,
            accountType: LINKED,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
      : [],
  };
}

function prismaMock() {
  const mocks: Record<string, unknown> = {
    peridotAccount: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async (args: { data: { identityId: string } }) => ({
          id: `acc-${args.data.identityId}`,
          identityId: args.data.identityId,
          status: "active",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
    },
    chainAccount: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async (args: {
          data: { accountId: string; chainNamespace: string; chainReference: string; address: string; accountType: string };
        }) => ({
          id: "wallet-1",
          ...args.data,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
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
  it("getMe returns the linked_address for the authenticated PID", async () => {
    const { service, prisma } = setup();
    prisma.peridotAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1"));

    const wallet = await service.getMe("pid_01HASH");

    expect(wallet).toEqual({
      id: "w-pid_01HASH",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: expect.any(Date),
    });
    expect(prisma.peridotAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { identityId: "pid_01HASH", status: "active" },
      }),
    );
  });

  it("getMe throws NotFound when the PID has no wallet", async () => {
    const { service } = setup();

    await expect(service.getMe("pid_01HASH")).rejects.toThrow(NotFoundException);
  });

  it("create creates a default account and persists a solana linked_address", async () => {
    const { service, prisma } = setup();

    const wallet = await service.create("pid_01HASH", "addr-solana");

    expect(prisma.peridotAccount.create).toHaveBeenCalledWith({
      data: { identityId: "pid_01HASH" },
    });
    expect(prisma.chainAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          accountId: "acc-pid_01HASH",
          chainNamespace: "solana",
          chainReference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
          address: "addr-solana",
          accountType: LINKED,
        },
      }),
    );
    expect(wallet.address).toBe("addr-solana");
    expect(wallet.chain).toBe("solana");
  });

  it("create returns the existing linked_address instead of creating a duplicate", async () => {
    const { service, prisma } = setup();
    prisma.peridotAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1"));
    prisma.chainAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1").chainAccounts[0]);

    const wallet = await service.create("pid_01HASH", "addr-2");

    expect(wallet.address).toBe("addr-1");
    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
  });

  it("create returns the existing wallet when a concurrent duplicate hits the unique index", async () => {
    const { service, prisma } = setup();
    prisma.peridotAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", false, ""));
    prisma.chainAccount.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    prisma.chainAccount.findFirst
      .mockResolvedValueOnce(null) // the pre-create existence check
      .mockResolvedValueOnce(accountRow("pid_01HASH", true, "addr-1").chainAccounts[0]); // the P2002 recovery

    const wallet = await service.create("pid_01HASH", "addr-1");

    expect(wallet.address).toBe("addr-1");
    expect(prisma.chainAccount.create).toHaveBeenCalledTimes(1);
  });
});