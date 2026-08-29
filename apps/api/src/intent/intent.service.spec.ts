import { BadRequestException, NotFoundException } from "@nestjs/common";
import { IntentService } from "./intent.service";

const ACCOUNT_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const SMART_ADDR = "G8tPCQRqZAg5R2TDGkcRKw8vZN3tJMdtyHGbaQhW5o4G";

function accountRow() {
  return {
    id: ACCOUNT_ID,
    identityId: "pid_01HASH",
    status: "active",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    chainAccounts: [
      { id: "chain-1", accountId: ACCOUNT_ID, chainNamespace: "solana", chainReference: "ref", address: SMART_ADDR, accountType: "smart_account", status: "active", createdAt: new Date(), updatedAt: new Date() },
    ],
  };
}

function intentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "intent-1",
    accountId: ACCOUNT_ID,
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
    accountId: ACCOUNT_ID,
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
  const config = { get: jest.fn((key: string) => (key === "SOLANA_NETWORK" ? "devnet" : undefined)) };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    pidAccount: { findFirst: jest.fn(async () => null as any) },
    authority: { count: jest.fn(async () => 1) },
    intent: {
      create: jest.fn(async () => intentRow()),
      findFirst: jest.fn(async () => null as any),
      update: jest.fn(async () => intentRow({ status: "executed" })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    transaction: {
      create: jest.fn(async () => txRow()),
      findFirst: jest.fn(async () => null as any),
    },
  };
  const service = new IntentService(prisma as never, config as never, security as never);
  return { service, prisma, security };
}

const DEST = "DeSt1111111111111111111111111111111111111";

describe("IntentService", () => {
  it("creates a WITHDRAW_SOL intent with policy + ownership context", async () => {
    const { service, prisma, security } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());

    const view = await service.createIntent("pid_01HASH", {
      type: "WITHDRAW_SOL",
      payload: { amount: "5000000", destination: DEST },
    });

    expect(view.id).toBe("intent-1");
    expect(view.status).toBe("pending");
    expect(prisma.intent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: ACCOUNT_ID,
          type: "WITHDRAW_SOL",
          payload: expect.objectContaining({ amount: "5000000", destination: DEST, chain: "solana", network: "devnet", smartAccountAddress: SMART_ADDR }),
        }),
      }),
    );
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.created", expect.any(Object), ACCOUNT_ID);
  });

  it("rejects a zero/negative amount", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "0", destination: DEST } })).rejects.toThrow(BadRequestException);
    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "-5", destination: DEST } })).rejects.toThrow(BadRequestException);
  });

  it("rejects an invalid destination", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: "not-a-pubkey!" } })).rejects.toThrow(BadRequestException);
  });

  it("rejects withdrawing to the smart account itself", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: SMART_ADDR } })).rejects.toThrow(BadRequestException);
  });

  it("rejects an account with no registered authority (passkey)", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());
    prisma.authority.count.mockResolvedValue(0);

    await expect(service.createIntent("pid_01HASH", { type: "WITHDRAW_SOL", payload: { amount: "1", destination: DEST } })).rejects.toThrow(BadRequestException);
  });

  it("records a submitted transaction and marks the intent executed (single-use)", async () => {
    const { service, prisma, security } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow());

    const view = await service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig1" });

    expect(view.txHash).toBe("sig1");
    expect(prisma.intent.update).toHaveBeenCalledWith({ where: { id: "intent-1" }, data: { status: "executed" } });
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.executed", expect.any(Object), ACCOUNT_ID);
  });

  it("rejects replaying an already-executed intent", async () => {
    const { service, prisma, security } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow({ status: "executed" }));

    await expect(service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig2" })).rejects.toThrow(BadRequestException);
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "intent.replay_rejected", expect.any(Object), ACCOUNT_ID);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it("rejects an expired intent", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValue(accountRow());
    prisma.intent.findFirst.mockResolvedValue(intentRow({ expiresAt: new Date(Date.now() - 1000) }));

    await expect(service.recordTransaction("pid_01HASH", { intentId: "intent-1", txHash: "sig3" })).rejects.toThrow(BadRequestException);
  });

  it("throws NotFound for another PID's transaction", async () => {
    const { service } = setup();

    await expect(service.getTransaction("pid_OTHER", "tx-1")).rejects.toThrow(NotFoundException);
  });
});