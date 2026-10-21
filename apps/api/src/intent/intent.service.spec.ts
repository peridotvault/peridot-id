import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { IntentService } from "./intent.service";
import { mockSecurity, minimalChainsStub } from "../../test/factories";


const SMART_ADDR = "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT";

function smartRow() {
  return {
    id: "chain-1",
    pid: "pid_01HASH",
    chainId: "chain-sol",
    chain: { namespace: "solana", reference: "ref" },
    address: SMART_ADDR,
    accountType: "smart_account",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function intentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "intent-1",
    pid: "pid_01HASH",
    type: "WITHDRAW_SOL",
    payload: { amount: "5000000", destination: "dest1111111111111111111111111111111111111", chain: "solana", network: "devnet" },
    status: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function txRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tx-1",
    pid: "pid_01HASH",
    chainAccountId: "chain-1",
    intentId: "intent-1",
    chain: "solana",
    network: "devnet",
    txHash: "sig1",
    status: "submitted",
    createdAt: new Date(),
    ...overrides,
  };
}

function setup() {
  const security = mockSecurity();
  const prisma = {
    chainAccount: { findFirst: jest.fn(async () => null as any) },
    authority: { count: jest.fn(async () => 1) },
    intent: {
      create: jest.fn(async () => intentRow()),
      findFirst: jest.fn(async () => null as any),
      update: jest.fn(async () => intentRow({ status: "executed" })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    transaction: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => txRow({ ...args.data })),
      findFirst: jest.fn(async () => null as any),
      findMany: jest.fn(async () => [] as any),
    },
  };
  const service = new IntentService(prisma as never, security as never, minimalChainsStub() as never);
  return { service, prisma, security };
}

const DEST = "DeSt1111111111111111111111111111111111111";

describe("IntentService", () => {
  it("creates a WITHDRAW_SOL intent with policy + ownership context", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    const view = await service.createIntent("pid_01HASH", {
      type: "WITHDRAW_SOL",
      payload: { amount: "5000000", destination: DEST },
    });

    expect(view.id).toBe("intent-1");
    expect(view.status).toBe("pending");
    expect(prisma.intent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pid: "pid_01HASH",
          type: "WITHDRAW_SOL",
          payload: expect.objectContaining({ amount: "5000000", destination: DEST, chain: "solana", network: "devnet", smartAccountAddress: SMART_ADDR }),
        }),
      }),
    );
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.created", expect.any(Object));
  });

  it("rejects a zero/negative amount", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "0", destination: DEST } })).rejects.toThrow(BadRequestException);
    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "-5", destination: DEST } })).rejects.toThrow(BadRequestException);
  });

  it("rejects an invalid destination", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: "not-a-pubkey!" } })).rejects.toThrow(BadRequestException);
  });

  it("rejects withdrawing to the smart account itself", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: SMART_ADDR } })).rejects.toThrow(BadRequestException);
  });

  it("rejects an account with no registered authority (passkey)", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.authority.count.mockResolvedValue(0);

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: DEST } })).rejects.toThrow(BadRequestException);
  });

  it("records a submitted transaction and marks the intent executed (single-use)", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());

    const view = await service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig1" });

    expect(view.txHash).toBe("sig1");
    expect(prisma.intent.update).toHaveBeenCalledWith({ where: { id: "intent-1" }, data: { status: "executed" } });
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.executed", expect.any(Object));
  });

  it("maps a cross-intent signature replay (P2002 on txHash) to 400, not 500", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());
    prisma.transaction.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig1" })).rejects.toThrow(
      "signature already recorded",
    );
  });

  it("maps a duplicate activity signature (P2002 on txHash) to 400, not 500", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.transaction.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(
      service.recordActivity("pid_01HASH", { type: "DEPOSIT", amount: "1000000", asset: "SOL", direction: "in", txHash: "sig2" }),
    ).rejects.toThrow("signature already recorded");
  });

  it("rejects replaying an already-executed intent", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow({ status: "executed" }));

    await expect(service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig2" })).rejects.toThrow(BadRequestException);
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.replay_rejected", expect.any(Object));
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it("rejects an expired intent", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow({ expiresAt: new Date(Date.now() - 1000) }));

    await expect(service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig3" })).rejects.toThrow(BadRequestException);
  });

  it("throws NotFound for another PID's transaction", async () => {
    const { service } = setup();

    await expect(service.getTransaction("pid_OTHER", "tx-1")).rejects.toThrow(NotFoundException);
  });

  it("records an activity entry (deposit/withdraw/activation) with metadata", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    const view = await service.recordActivity("pid_01HASH", {
      type: "WITHDRAW",
      amount: "5000000",
      asset: "SOL",
      direction: "out",
      counterparty: DEST,
      txHash: "sig1",
    });

    expect(view.type).toBe("WITHDRAW");
    expect(view.amount).toBe("5000000");
    expect(view.counterparty).toBe(DEST);
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pid: "pid_01HASH",
          chainAccountId: "chain-1",
          type: "WITHDRAW",
          amount: 5000000n,
          direction: "out",
          status: "submitted",
        }),
      }),
    );
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "activity.recorded", expect.any(Object));
  });

  it("records activity without a counterparty (deposits)", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());

    await service.recordActivity("pid_01HASH", { type: "DEPOSIT", amount: "1000000", asset: "SOL", direction: "in", txHash: "sig2" });

    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ direction: "in", counterparty: null }) }),
    );
  });

  it("lists transaction history newest-first, scoped to the identity", async () => {
    const { service, prisma } = setup();
    prisma.transaction.findMany = jest.fn(async () => [txRow()]);

    const views = await service.listTransactions("pid_01HASH");

    expect(views).toHaveLength(1);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pid: "pid_01HASH" },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("server-asserts mainnet network from chain, ignoring client network", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());
    const chains = (service as unknown as { chains: { activeChains: jest.Mock } }).chains;
    chains.activeChains.mockResolvedValue([
      { namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z", isTestnet: false },
    ]);

    const view = await service.recordTransaction("pid_01HASH", {
      intentId: "intent-1",
      txHash: "sig1",
      network: "devnet",
      chain: { namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" },
    });

    expect(view.network).toBe("mainnet-beta");
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ network: "mainnet-beta" }) }),
    );
  });

  it("server-asserts devnet network for a testnet chain row", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());
    const chains = (service as unknown as { chains: { activeChains: jest.Mock } }).chains;
    chains.activeChains.mockResolvedValue([{ namespace: "solana", reference: "EtWTRABZaYq6iMfeYKouRu166VU2xqaHM", isTestnet: true }]);

    const view = await service.recordTransaction("pid_01HASH", {
      intentId: "intent-1",
      txHash: "sig1",
      chain: { namespace: "solana", reference: "EtWTRABZaYq6iMfeYKouRu166VU2xqaHM" },
    });

    expect(view.network).toBe("devnet");
  });

  it("rejects a non-solana namespace pre-write with no rows created", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());

    await expect(
      service.recordTransaction("pid_01HASH", {
        intentId: "intent-1",
        txHash: "sig1",
        chain: { namespace: "eip155", reference: "1" },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.intent.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown chain reference pre-write with no rows created", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());
    const chains = (service as unknown as { chains: { activeChains: jest.Mock } }).chains;
    chains.activeChains.mockResolvedValue([]);

    await expect(
      service.recordTransaction("pid_01HASH", {
        intentId: "intent-1",
        txHash: "sig1",
        chain: { namespace: "solana", reference: "nope" },
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.intent.update).not.toHaveBeenCalled();
  });

  it("keeps legacy behavior when chain is absent (client network honored)", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(smartRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());

    const view = await service.recordTransaction("pid_01HASH", {
      intentId: "intent-1",
      txHash: "sig1",
      network: "devnet",
    });

    expect(view.network).toBe("devnet");
  });
});