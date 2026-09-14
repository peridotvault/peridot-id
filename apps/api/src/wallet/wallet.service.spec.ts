import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WalletService } from "./wallet.service";
import { minimalChainsStub } from "../../test/factories";


const LINKED = "linked_address";

function accountRow(pid: string, withLinked: boolean, address: string) {
  return {
    id: `acc-${pid}`,
    pid,
    status: "active",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    chainAccounts: withLinked
      ? [
          {
            id: `w-${pid}`,
            accountId: `acc-${pid}`,
            chainId: "chain-sol",
            chain: { namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" },
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
    pidAccount: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async (args: { data: { pid: string } }) => ({
          id: `acc-${args.data.pid}`,
          pid: args.data.pid,
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
          data: { accountId: string; chainId: string; address: string; accountType: string };
        }) => ({
          id: "wallet-1",
          ...args.data,
          chain: { namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" },
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
    },
    chain: {
      findUnique: jest.fn(async () => ({ id: "chain-sol" })),
    },
  };
  return mocks as any;
}

function setup() {
  const prisma = prismaMock();
  const chains = minimalChainsStub();
  const service = new WalletService(prisma as never, chains as never);
  return { service, prisma, chains };
}

describe("WalletService", () => {
  it("getMe returns the linked_address for the authenticated PID", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1"));

    const wallet = await service.getMe("pid_01HASH");

    expect(wallet).toEqual({
      id: "w-pid_01HASH",
      chain: "solana",
      address: "addr-1",
      status: "active",
      createdAt: expect.any(Date),
    });
    expect(prisma.pidAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pid: "pid_01HASH", status: "active" },
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

    expect(prisma.pidAccount.create).toHaveBeenCalledWith({
      data: { pid: "pid_01HASH" },
    });
    expect(prisma.chainAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          accountId: "acc-pid_01HASH",
          chainId: "chain-sol",
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
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1"));
    prisma.chainAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", true, "addr-1").chainAccounts[0]);

    const wallet = await service.create("pid_01HASH", "addr-2");

    expect(wallet.address).toBe("addr-1");
    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
  });

  it("create returns the existing wallet when a concurrent duplicate hits the unique index", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow("pid_01HASH", false, ""));
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