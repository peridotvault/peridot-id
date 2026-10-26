import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ActivationService } from "./activation.service";
import { SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE } from "../common/chains";
import { mockSecurity, mockIdempotency, mockBreaker, solanaRelayerConfig, minimalChainsStub, COSE_HEX, TREASURY } from "../../test/factories";


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
  parseTransaction: jest.fn(async () => ({ signature: "sig1", fee: NETWORK })),
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
    chain: { namespace: "solana", reference: SOLANA_DEVNET_REFERENCE },
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
  // ANT-193: confirm attempts are a hardcoded constant (15); the never-confirms
  // test below budgets for the full window.
  const config = solanaRelayerConfig({});
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

  const service = new ActivationService(prisma as never, config as never, security as never, minimalChainsStub() as never, mockIdempotency() as never, mockBreaker() as never);
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

    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });

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
    // H2 + H1.iv: resolve-then-act outcome and per-tx P&L with contract keys.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relay.resolve_landed",
      expect.objectContaining({ chain: "solana", entryPoint: "activate", signature: "sig1" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relayer.pnl",
      expect.objectContaining({
        chain: "solana",
        entryPoint: "activate",
        signature: "sig1",
        absorbed: "0",
        attested: String(NETWORK),
        actual: String(NETWORK),
      }),
    );
  });

  it("rejects an assertion from an unknown credential", async () => {
    const { service, prisma } = setup();
    (prisma.authority.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), status: "active" })
      .mockResolvedValueOnce(null);
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "nope", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("returns 503 and creates no rows when the relayer is unfunded", async () => {    const { service, prisma, security } = setup();
    relayerBalance = 0; // Peridot's float account is empty

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

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

      await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

      expect(adapterMock.activateV3).toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.chainAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
      );
      expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object));
    },
    30000,
  );

  it("reverts and does not mark active when the tx confirms with an error", async () => {
    const { service, prisma, security } = setup();
    adapterMock.getStatus.mockResolvedValue({ confirmed: true, error: '{"InstructionError":0}', signature: "sig1" });

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "account.activation.unconfirmed", expect.any(Object));
  });

  it("refuses to activate when the live status is not ready", async () => {    const { service } = setup();
    userBalance = 0; // user address not funded → inactivated

    await expect(service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } })).rejects.toThrow(ConflictException);
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
      return isActivatedCalls >= 3; // early loop iterations + final check
    });

    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });

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

  it("skips poll rows with an unmapped solana reference instead of quoting the default cluster", async () => {
    // Fail-closed for a future third Solana row (ANT-40): the group must never
    // be read or quoted against the default cluster — it is skipped with an alert.
    const { service, prisma, security } = setup();
    prisma.chainAccount.findMany.mockResolvedValue([
      chainRow({ status: "ready", chain: { namespace: "solana", reference: "future-third-row" } }),
    ] as never);

    await service.poll();

    expect((service as unknown as { chains: { solanaRpcUrl: jest.Mock } }).chains.solanaRpcUrl).not.toHaveBeenCalled();
    expect(adapterMock.estimateActivationCost).not.toHaveBeenCalled();
    expect(adapterMock.getBalanceOf).not.toHaveBeenCalled();
    expect(prisma.chainAccount.update).not.toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "account.activation.unmapped_chain",
      expect.objectContaining({ reference: "future-third-row" }),
    );
  });

  it("rejects drift beyond 120% of the quoted network fee without broadcasting", async () => {
    const { service, security } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(QUOTED_TOO_SMALL), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
    // H1.v + H1.ii: drift pair with the exact contract keys.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "quote.drift_rejected",
      expect.objectContaining({
        chain: "solana",
        entryPoint: "activate",
        quoted: String(QUOTED_TOO_SMALL),
        attested: String(NETWORK),
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ chain: "solana", entryPoint: "activate", cause: "drift" }),
    );
  });

  it("accepts attestation at exactly 120% of the quote", async () => {
    // attested 820880 vs quoted 684067: 820880×100 == 82088000 < 684067×120 == 82088040.
    const { service } = setup();
    adapterMock.isActivated.mockImplementation(async () => adapterMock.activateV3.mock.calls.length > 0);
    const view = await service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: "684067", maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } });
    expect(view.status).toBe("active");
    expect(adapterMock.activateV3).toHaveBeenCalledTimes(1);
  });

  it("rejects attestation one unit above the 120% boundary", async () => {
    // attested 820880 vs quoted 684066: 820880×100 == 82088000 > 684066×120 == 82087920.
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: "684066", maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("rejects an authorization lifetime beyond 600 seconds", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000901, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("rejects an unsupported fee policy version", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL), feePolicyVersion: 99, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });

  it("exposes the fee policy version without any domain binding in the activation view", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID });
    expect(view.feePolicyVersion).toBe(2);
    expect(view.networkFeeLamports).toBe(NETWORK);
    expect(view.protocolFeeBps).toBe(5000);
    expect(view).not.toHaveProperty("rpIdHash");
  });

  it("omits the chain echo when the registry has no Solana row", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID });
    expect(view.chain).toBeUndefined();
  });

  it("echoes the selected Solana chain when a selection is passed (ANT-626)", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockImplementation(async (selection?: string) => ({
      namespace: "solana",
      reference: selection === "testnet" ? SOLANA_TESTNET_REFERENCE : SOLANA_DEVNET_REFERENCE,
    }));
    const view = await service.viewOf({ pid: IDENTITY_ID }, "testnet");
    expect(chains.solanaChain).toHaveBeenCalledWith("testnet");
    expect(view.chain).toEqual({ namespace: "solana", reference: SOLANA_TESTNET_REFERENCE });
  });

  it("echoes the active Solana chain when the registry has one", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockResolvedValue({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
    const view = await service.viewOf({ pid: IDENTITY_ID });
    expect(view.chain).toEqual({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
  });

  it("exposes the v2 canonical quote shape in the activation view", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID });
    expect(view.networkFee).toBe(String(NETWORK));
    expect(view.platformFee).toBe(String(PROTOCOL));
    expect(view.totalFee).toBe(String(NETWORK + PROTOCOL));
    expect(view.maxTotalFee).toBe(String(NETWORK + PROTOCOL));
    expect(view.chainMinBaseUnits).toBe("17000");
    expect(new Date(view.expiresAt).getTime() - new Date(view.quotedAt).getTime()).toBe(300_000);
  });

  it("rejects a total above the user-authorized maxTotalFee without broadcasting", async () => {
    const { service, security } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: String(NETWORK + PROTOCOL - 1), feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "account.activation.max_total_exceeded",
      expect.objectContaining({ totalFee: String(NETWORK + PROTOCOL) }),
    );
  });

  it("rejects a non-numeric maxTotalFee as a bad request", async () => {
    const { service } = setup();
    await expect(
      service.activate({ pid: IDENTITY_ID }, { expiry: 1000000300, quotedNetworkFeeLamports: String(NETWORK), maxTotalFeeLamports: "lots", feePolicyVersion: 2, assertion: { id: "cred-1", signature: "c2ln", authenticatorData: "YXV0aA", clientDataJSON: "e30" } }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.activateV3).not.toHaveBeenCalled();
  });
});