import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ActivationService } from "./activation.service";
import { mockSecurity, solanaRelayerConfig, COSE_HEX, TREASURY } from "../../test/factories";


const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const COST = 1592460;
const NETWORK = 800880 + 20000; // rent + message fee from the mocked estimate
const PROTOCOL = Math.floor((NETWORK * 5000) / 10000); // 410440
const QUOTED_TOO_SMALL = 100000; // 820880×100 > 100000×120 → drift rejection

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
    marginLamports: BigInt(0),
  })),
  activateV3: jest.fn(async () => "sig1"),
  chainTime: jest.fn(async () => 1000000000),
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
  b64urlToBytes: jest.fn((s: string) => Uint8Array.from(Buffer.from(s, "base64url"))),
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
  adapterMock.activateV3.mockResolvedValue("sig1");
});

describe("ActivationService", () => {
  it("activates and records a confirmed ACTIVATION row on success", async () => {
    const { service, prisma, security } = setup();
    // Pre-check (before sending): not yet program-owned. After `adapter.activate` runs, the
    // PDA becomes program-owned — flip the response so viewOf reports active.
    adapterMock.isActivated.mockImplementation(async () => adapterMock.activateV3.mock.calls.length > 0);

    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });

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
          amount: BigInt(NETWORK + PROTOCOL),
        }),
      }),
    );
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "active" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activated", expect.any(Object));
  });

  it("rejects an assertion from an unknown credential", async () => {
    const { service, prisma } = setup();
    (prisma.authority.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), status: "active" })
      .mockResolvedValueOnce(null);
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "nope", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("returns 503 and creates no rows when the relayer is unfunded", async () => {    const { service, prisma, security } = setup();
    relayerBalance = 0; // Peridot's float account is empty

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

    expect(adapterMock.activateV3).not.toHaveBeenCalled();
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

      await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

      expect(adapterMock.activateV3).toHaveBeenCalled();
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

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object));
  });

  it("refuses to activate when the live status is not ready", async () => {    const { service } = setup();
    userBalance = 0; // user address not funded → inactivated

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
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

    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });

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

  it("rejects drift beyond 120% of the quoted network fee without broadcasting", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(QUOTED_TOO_SMALL), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("accepts attestation at exactly 120% of the quote", async () => {
    // attested 820880 vs quoted 684067: 820880×100 == 82088000 < 684067×120 == 82088040.
    const { service } = setup();
    adapterMock.isActivated.mockImplementation(async () => adapterMock.activateV3.mock.calls.length > 0);
    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: "684067", feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });
    expect(view.status).toBe("active");
    expect(adapterMock.activateV3).toHaveBeenCalledTimes(1);
  });

  it("rejects attestation one unit above the 120% boundary", async () => {
    // attested 820880 vs quoted 684066: 820880×100 == 82088000 > 684066×120 == 82087920.
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: "684066", feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("rejects an authorization lifetime beyond 600 seconds", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000901, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 1, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("rejects an unsupported fee policy version", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("exposes the fee policy version and RP-ID hash in the activation view", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID });
    expect(view.feePolicyVersion).toBe(1);
    expect(view.networkFeeLamports).toBe(NETWORK);
    expect(view.protocolFeeBps).toBe(5000);
    expect(typeof view.rpIdHash).toBe("string");
    expect(view.rpIdHash.length).toBeGreaterThan(0);
  });
});