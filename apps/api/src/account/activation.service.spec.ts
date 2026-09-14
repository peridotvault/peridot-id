import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ActivationService } from "./activation.service";
import { mockSecurity, solanaRelayerConfig, COSE_HEX, TREASURY } from "../../test/factories";


const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const COST = 1592460;

class MockPublicKey {
  constructor(public readonly addr: string) {}
  toBase58(): string {
    return this.addr;
  }
}

// getBalanceOf routes by address: the user PDA returns `userBalance`; the relayer pubkey
// returns `relayerBalance`. Set per-test via the module-level vars (reset in beforeEach).
let relayerBalance = 1_000_000_000;
let userBalance = 100_000_000;

const adapterMock = {
  getBalanceOf: jest.fn(async (addr: { toBase58: () => string } | string) => {
    const s = typeof addr === "string" ? addr : addr.toBase58();
    return s === RELAYER ? relayerBalance : userBalance;
  }),
  isActivated: jest.fn(async () => false),
  estimateActivationCost: jest.fn(async () => ({
    totalLamports: BigInt(COST),
    rentLamports: BigInt(800880),
    feeLamports: BigInt(20000),
    marginLamports: BigInt(823760),
  })),
  activate: jest.fn(async () => "sig1"),
  getStatus: jest.fn(async () => ({ confirmed: true, error: undefined, signature: "sig1" })) as jest.Mock<Promise<{ confirmed: boolean; error?: string; signature: string }>>,
};

jest.mock("@peridotvault/pid-solana", () => ({
  Keypair: {
    fromSecretKey: jest.fn(() => ({ publicKey: new MockPublicKey(RELAYER) })),
  },
  PublicKey: MockPublicKey,
  SolanaAdapter: jest.fn(() => adapterMock),
  SolanaRpc: jest.fn(() => ({})),
  fromHex: jest.fn((hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))),
}));

function chainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "chain-1",
    pid: IDENTITY_ID,
    chainId: "chain-sol",
    chain: { namespace: "solana", reference: "ref" },
    address: SMART_ADDR,
    accountType: "smart_account",
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date()
    ,
    ...overrides,
  };
}

function setup() {
  const config = solanaRelayerConfig({
    PID_ACTIVATION_CONFIRM_ATTEMPTS: "2",
    PID_ACTIVATION_CONFIRM_INTERVAL_MS: "5",
  });
  const security = mockSecurity();
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => chainRow() as never),
      update: jest.fn(async (_: unknown) => ({})),
      findMany: jest.fn(async () => [] as never),
    },
    authority: { findFirst: jest.fn(async () => ({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), status: "active" }) as never) },
    transaction: { create: jest.fn(async (a: unknown) => a), updateMany: jest.fn(async () => ({ count: 0 })) },
    securityEvent: { create: jest.fn(async () => ({})) },
  };

  const service = new ActivationService(prisma as never, config as never, security as never);
  return { service, prisma, security };
}

beforeEach(() => {
  jest.clearAllMocks();
  relayerBalance = 1_000_000_000;
  userBalance = 100_000_000;
  adapterMock.isActivated.mockResolvedValue(false);
  adapterMock.getStatus.mockResolvedValue({ confirmed: true, error: undefined, signature: "sig1" });
  adapterMock.activate.mockResolvedValue("sig1");
});

describe("ActivationService", () => {
  it("activates and records a confirmed ACTIVATION row on success", async () => {
    const { service, prisma, security } = setup();
    // Pre-check (before sending): not yet program-owned. After `adapter.activate` runs, the
    // PDA becomes program-owned — flip the response so viewOf reports active.
    adapterMock.isActivated.mockImplementation(async () => adapterMock.activate.mock.calls.length > 0);

    const view = await service.activate({ pid: IDENTITY_ID });

    expect(view.status).toBe("active");
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "ACTIVATION",
          status: "confirmed",
          confirmedAt: expect.any(Date),
          txHash: "sig1",
          direction: "out",
          counterparty: TREASURY,
        }),
      }),
    );
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "active" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activated", expect.any(Object));
  });

  it("returns 503 and creates no rows when the relayer is unfunded", async () => {
    const { service, prisma, security } = setup();
    relayerBalance = 0; // Peridot's float account is empty

    await expect(service.activate({ pid: IDENTITY_ID })).rejects.toThrow(ServiceUnavailableException);

    expect(adapterMock.activate).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.relayer_unfunded", expect.any(Object));
  });

  it(
    "reverts to ready and creates no rows when the tx never confirms",
    async () => {
      const { service, prisma, security } = setup();
      adapterMock.getStatus.mockResolvedValue({ confirmed: false, signature: "sig1" } as never); // never lands

      await expect(service.activate({ pid: IDENTITY_ID })).rejects.toThrow(ServiceUnavailableException);

      expect(adapterMock.activate).toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.chainAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
      );
      expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object));
    },
    20000,
  );

  it("reverts and does not mark active when the tx confirms with an error", async () => {
    const { service, prisma, security } = setup();
    adapterMock.getStatus.mockResolvedValue({ confirmed: true, error: '{"InstructionError":0}', signature: "sig1" });

    await expect(service.activate({ pid: IDENTITY_ID })).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object));
  });

  it("refuses to activate when the live status is not ready", async () => {
    const { service } = setup();
    userBalance = 0; // user address not funded → inactivated

    await expect(service.activate({ pid: IDENTITY_ID })).rejects.toThrow(ConflictException);
    expect(adapterMock.activate).not.toHaveBeenCalled();
  });

  it("heals a stale active row in the poll when the account is not actually activated", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findMany.mockResolvedValue([chainRow({ status: "active" })] as never);
    adapterMock.isActivated.mockResolvedValue(false);

    await service.poll();

    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "inactivated" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.healed", expect.any(Object));
  });

  it("leaves an actually-activated active row alone in the poll", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findMany.mockResolvedValue([chainRow({ status: "active" })] as never);
    adapterMock.isActivated.mockResolvedValue(true);

    await service.poll();

    expect(prisma.chainAccount.update).not.toHaveBeenCalled();
  });

  it("treats a timeout-but-on-chain-active tx as success", async () => {
    const { service, prisma } = setup();
    // Never reports the tx via getStatus, but the final isActivated check finds the live PDA.
    adapterMock.getStatus.mockResolvedValue({ confirmed: false, signature: "sig1" } as never);
    let isActivatedCalls = 0;
    adapterMock.isActivated.mockImplementation(async () => {
      isActivatedCalls++;
      return isActivatedCalls >= 3; // loop(2) + final check
    });

    const view = await service.activate({ pid: IDENTITY_ID });

    expect(view.status).toBe("active");
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "confirmed" }) }),
    );
    expect(prisma.transaction.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("promotes a ready row to active in the poll once the account is on-chain", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findMany.mockResolvedValue([chainRow({ status: "ready" })] as never);
    adapterMock.isActivated.mockResolvedValue(true);

    await service.poll();

    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "active" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.promoted", expect.any(Object));
  });
});