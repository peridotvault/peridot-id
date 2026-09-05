import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ActivationService } from "./activation.service";

const ACCOUNT_ID = "50997bcf-f3e3-406b-bc77-7108593ef5cb";
const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const TREASURY = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const COST = 1592460;

// A valid ES256 COSE_Key so the authority → compressed-pubkey conversion succeeds.
const COSE_HEX =
  "a5010203262001215820c728cac553ac9c7e6741694959adfbc1b5466df7071c8ea40fa05782c9628b8422582074d2fa89ce2b706497759bb98da015280bb379675f3476a378a6ce8a220ba639";

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
    accountId: ACCOUNT_ID,
    chainNamespace: "solana",
    chainReference: "ref",
    address: SMART_ADDR,
    accountType: "smart_account",
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    account: { id: ACCOUNT_ID, identityId: IDENTITY_ID, status: "active" },
    ...overrides,
  };
}

function setup() {
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const values: Record<string, unknown> = {
        PID_SOLANA_RPC_URL: "https://api.devnet.solana.com",
        PID_ACTIVATION_CONFIRM_ATTEMPTS: "2",
        PID_ACTIVATION_CONFIRM_INTERVAL_MS: "5",
      };
      return values[key] ?? def;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === "PID_RELAYER_SECRET") return "11".repeat(32);
      if (key === "PID_TREASURY_PUBKEY") return TREASURY;
      throw new Error(`Missing config: ${key}`);
    }),
  };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => chainRow() as never),
      update: jest.fn(async (_: unknown) => ({})),
      findMany: jest.fn(async () => [] as never),
    },
    authority: { findFirst: jest.fn(async () => ({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), accountId: ACCOUNT_ID, status: "active" }) as never) },
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

    const view = await service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID);

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
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activated", expect.any(Object), ACCOUNT_ID);
  });

  it("returns 503 and creates no rows when the relayer is unfunded", async () => {
    const { service, prisma, security } = setup();
    relayerBalance = 0; // Peridot's float account is empty

    await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID)).rejects.toThrow(ServiceUnavailableException);

    expect(adapterMock.activate).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.relayer_unfunded", expect.any(Object), ACCOUNT_ID);
  });

  it(
    "reverts to ready and creates no rows when the tx never confirms",
    async () => {
      const { service, prisma, security } = setup();
      adapterMock.getStatus.mockResolvedValue({ confirmed: false, signature: "sig1" } as never); // never lands

      await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID)).rejects.toThrow(ServiceUnavailableException);

      expect(adapterMock.activate).toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.chainAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
      );
      expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object), ACCOUNT_ID);
    },
    20000,
  );

  it("reverts and does not mark active when the tx confirms with an error", async () => {
    const { service, prisma, security } = setup();
    adapterMock.getStatus.mockResolvedValue({ confirmed: true, error: '{"InstructionError":0}', signature: "sig1" });

    await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID)).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object), ACCOUNT_ID);
  });

  it("refuses to activate when the live status is not ready", async () => {
    const { service } = setup();
    userBalance = 0; // user address not funded → inactivated

    await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID)).rejects.toThrow(ConflictException);
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
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.healed", expect.any(Object), ACCOUNT_ID);
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

    const view = await service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID);

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
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.promoted", expect.any(Object), ACCOUNT_ID);
  });
});