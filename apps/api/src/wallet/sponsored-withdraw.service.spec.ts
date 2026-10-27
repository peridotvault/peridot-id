import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { SponsoredWithdrawService } from "./sponsored-withdraw.service";
import { SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE } from "../common/chains";
import { mockSecurity, mockIdempotency, mockBreaker, solanaRelayerConfig, minimalChainsStub, COSE_HEX } from "../../test/factories";


const ACCOUNT_ID = "50997bcf-f3e3-406b-bc77-7108593ef5cb";
const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const DEST = "DeSt1111111111111111111111111111111111111";
// ANT-635: fee vault is the ["treasury"] PDA per program id (valid base58).
const TREASURY_PDA = "VzTreasuryPDA11111111111111111111111111111";

class MockPublicKey {
  constructor(public readonly addr: string) {
    // Mirror the real constructor: reject non-base58 input so the service's
    // 400-mapping (pubkeyOr400) is actually exercised by tests.
    if (/[^1-9A-HJ-NP-Za-km-z]/.test(addr)) throw new Error("Invalid public key");
  }
  toBase58(): string {
    return this.addr;
  }
}

let relayerBalance = 1_000_000_000;
const adapterMock = {
  isActivated: jest.fn(async () => true),
  estimateWithdrawFee: jest.fn(async () => 5000n),
  chainTime: jest.fn(async () => 1_000_000),
  getNonce: jest.fn(async () => 7n),
  getBalanceOf: jest.fn(async (addr: { toBase58: () => string } | string) => {
    const s = typeof addr === "string" ? addr : addr.toBase58();
    return s === RELAYER ? relayerBalance : 100_000_000;
  }),
  hasAccount: jest.fn(async () => true),
  tokenAta: jest.fn(async () => new MockPublicKey("AtAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAA")),
  getTokenBalancesOf: jest.fn(async () => [
    { mint: "USDCmint11111111111111111111111111111111", amount: "10000000", decimals: 6, account: "AtAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAA" },
  ]),
  treasuryAddress: jest.fn(() => new MockPublicKey(TREASURY_PDA)),
  parseTransaction: jest.fn(async () => ({ signature: "sig", fee: 5000 })),
  getHistory: jest.fn(async (): Promise<{ signature: string; err: unknown }[]> => []),
  sponsoredWithdrawSolV3: jest.fn(async () => "sig-sponsor-sol") as jest.Mock,
  sponsoredWithdrawTokenV3: jest.fn(async () => "sig-sponsor-token") as jest.Mock,
  estimateExecuteFee: jest.fn(async () => 10000n) as jest.Mock,
  sponsoredExecuteV3: jest.fn(async () => "sig-execute") as jest.Mock,
  waitForConfirmation: jest.fn(async () => "confirmed" as const),
  // ANT-729 (WS3) lazy-activation doubles.
  estimateCompositeWithdrawFee: jest.fn(async () => 8000n) as jest.Mock,
  estimateCompositeExecuteFee: jest.fn(async () => 12000n) as jest.Mock,
  rentExemption: jest.fn(async () => 900000n) as jest.Mock,
  sponsoredActivatePlusWithdrawSolV4: jest.fn(async () => "sig-first-action") as jest.Mock,
  sponsoredActivatePlusWithdrawTokenV4: jest.fn(async () => "sig-first-action-token") as jest.Mock,
  sponsoredActivatePlusExecuteV4: jest.fn(async () => "sig-first-action-exec") as jest.Mock,
  activateV4: jest.fn(async () => "sig-activate") as jest.Mock,
  sponsoredWithdrawSolV4: jest.fn(async () => "sig-spend-sol") as jest.Mock,
  sponsoredWithdrawTokenV4: jest.fn(async () => "sig-spend-token") as jest.Mock,
  sponsoredExecuteV4: jest.fn(async () => "sig-spend-exec") as jest.Mock,
};

jest.mock("@peridotvault/pid-solana", () => ({
  Keypair: { fromSecretKey: jest.fn(() => ({ publicKey: new MockPublicKey(RELAYER) })) },
  PublicKey: MockPublicKey,
  PID_PROGRAM_ID: "PidProgram1111111111111111111111111111111",
  SolanaAdapter: jest.fn(() => adapterMock),
  SolanaRpc: jest.fn(() => ({})),
  fromHex: jest.fn((hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))),
  b64urlToBytes: jest.fn((s: string) => Uint8Array.from(Buffer.from(s, "base64url"))),
}));

function setup(fees?: unknown) {
  const config = solanaRelayerConfig();
  const security = mockSecurity();
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => ({
        id: "chain-1",
        pid: IDENTITY_ID,
        chainId: "chain-sol",
        accountType: "smart_account",
        address: SMART_ADDR,
        status: "active",
      })),
    },
    authority: { findFirst: jest.fn(async () => ({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), pid: IDENTITY_ID, status: "active", credentialId: "cred-1" })) },
  };
  const chains = minimalChainsStub();
  chains.solanaProgramId.mockResolvedValue("PidProgram1111111111111111111111111111111");
  const idempotency = mockIdempotency();
  const breaker = mockBreaker();
  const service = new SponsoredWithdrawService(prisma as never, config as never, security as never, chains as never, idempotency as never, breaker as never, fees as never);
  return { service, security, idempotency };
}

const assertion = {
  id: "cred-1",
  signature: "A".repeat(86),
  authenticatorData: "B".repeat(50),
  clientDataJSON: "C".repeat(60),
};

const base = {
  asset: "SOL",
  to: DEST,
  amount: "5000000",
  nonce: "7",
  expiry: 1_000_300,
  feePolicyVersion: 2,
  quotedNetworkFeeLamports: "5000",
  maxTotalFeeLamports: "22000",
  assertion: assertion as never,
};

beforeEach(() => {
  jest.clearAllMocks();
  relayerBalance = 1_000_000_000;
  adapterMock.isActivated.mockResolvedValue(true);
  adapterMock.getNonce.mockResolvedValue(7n);
  adapterMock.getBalanceOf.mockImplementation(async (addr: { toBase58: () => string } | string) => {
    const s = typeof addr === "string" ? addr : addr.toBase58();
    return s === RELAYER ? relayerBalance : 100_000_000;
  });
  adapterMock.waitForConfirmation.mockResolvedValue("confirmed");
  adapterMock.sponsoredWithdrawSolV3.mockResolvedValue("sig-sponsor-sol");
});

describe("SponsoredWithdrawService", () => {
  it("quote returns network fee, fixed protocol percentage and chain time", async () => {
    const { service } = setup();
    const q = await service.quote(IDENTITY_ID);
    expect(BigInt(q.networkFeeLamports)).toBe(5000n);
    expect(q.protocolFeeBps).toBe(5000);
    expect(BigInt(q.totalFeeLamports)).toBe(7500n);
    expect(q.feePolicyVersion).toBe(2);
    expect(q.chainTime).toBe(1_000_000);
    // ANT-635: the quote names the ["treasury"] PDA, never an env const.
    expect(q.treasury).toBe(TREASURY_PDA);
  });

  it("quote on an ACTIVE account carries activation mode none (AC-15)", async () => {
    const { service } = setup();
    const q = await service.quote(IDENTITY_ID);
    expect(q.activation).toEqual({
      required: false,
      includedInTotal: false,
      estimate: "0",
      estimateBasis: "account-active",
      mode: "none",
    });
  });

  it("quote on an inactive wallet returns a lazy first-action quote (no gate)", async () => {
    const { service } = setup();
    adapterMock.isActivated.mockResolvedValue(false);
    adapterMock.getNonce.mockResolvedValue(0n);
    const q = await service.quote(IDENTITY_ID);
    // networkFee = rent(80B) + composite message fee; ANT-743 pure percentage.
    expect(BigInt(q.networkFeeLamports)).toBe(900000n + 8000n);
    expect(q.activation.required).toBe(true);
    expect(q.activation.includedInTotal).toBe(true);
    expect(q.activation.estimate).toBe((900000n + 8000n).toString());
    expect(q.activation.mode).toBe("svm-composite");
    // platformFee = pure 50% of 908000 = 454000 (minima removed, ANT-743).
    expect(q.platformFee).toBe("454000");
    expect(q.chainMinBaseUnits).toBe("0");
  });

  describe("ANT-729 lazy first-action submit", () => {
    const firstActionBase = {
      ...base,
      nonce: "0",
      quotedNetworkFeeLamports: "908000", // rent 900000 + composite 8000
      maxTotalFeeLamports: "1362000", // 908000 + pure-50% 454000 (ANT-743)
      activation: {
        expiry: 1_000_300,
        feePolicyVersion: 2,
        quotedActivationLamports: "908000",
        maxTotalFeeLamports: "1362000",
        assertion: assertion as never,
      },
    };

    beforeEach(() => {
      adapterMock.isActivated.mockResolvedValue(false);
      adapterMock.getNonce.mockResolvedValue(0n);
    });

    it("routes an inactive first action to the atomic composite (no gate)", async () => {
      const { service } = setup();
      const res = await service.withdraw(IDENTITY_ID, firstActionBase);
      expect(res.signature).toBe("sig-first-action");
      expect(res.status).toBe("confirmed");
      expect(res.activation).toEqual({ mode: "svm-composite" });
      expect(adapterMock.sponsoredActivatePlusWithdrawSolV4).toHaveBeenCalledTimes(1);
      expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
    });

    it("fail-closed re-quote when the activation leg is missing (never the legacy gate)", async () => {
      const { service } = setup();
      const { activation: _dropped, ...noLeg } = firstActionBase;
      await expect(service.withdraw(IDENTITY_ID, noLeg)).rejects.toThrow(ConflictException);
      await expect(service.withdraw(IDENTITY_ID, noLeg)).rejects.toThrow(/re-quote for first action/);
      expect(adapterMock.sponsoredActivatePlusWithdrawSolV4).not.toHaveBeenCalled();
      expect(adapterMock.activateV4).not.toHaveBeenCalled();
    });

    it("falls back to 2-step on TxTooLarge with identical UX + mode report", async () => {
      const { service } = setup();
      adapterMock.sponsoredActivatePlusWithdrawSolV4.mockRejectedValueOnce(new Error("TxTooLarge: composite exceeds packet ceiling"));
      const res = await service.withdraw(IDENTITY_ID, firstActionBase);
      expect(res.signature).toBe("sig-spend-sol");
      expect(res.activation).toEqual({ mode: "svm-fallback-2step" });
      expect(adapterMock.activateV4).toHaveBeenCalledTimes(1);
      expect(adapterMock.sponsoredWithdrawSolV4).toHaveBeenCalledTimes(1);
    });

    it("enforces FeeExceedsMax pre-claim (no half-activated state)", async () => {
      const { service } = setup();
      await expect(
        service.withdraw(IDENTITY_ID, { ...firstActionBase, maxTotalFeeLamports: "1000" }),
      ).rejects.toThrow(ConflictException);
      expect(adapterMock.sponsoredActivatePlusWithdrawSolV4).not.toHaveBeenCalled();
      expect(adapterMock.activateV4).not.toHaveBeenCalled();
    });

    it("requires the same passkey on both legs", async () => {
      const { service } = setup();
      const other = { ...firstActionBase, activation: { ...firstActionBase.activation, assertion: { ...assertion, id: "cred-2" } as never } };
      await expect(service.withdraw(IDENTITY_ID, other)).rejects.toThrow(BadRequestException);
      expect(adapterMock.sponsoredActivatePlusWithdrawSolV4).not.toHaveBeenCalled();
    });
  });

  it("withdraw broadcasts with the relayer and returns the confirmed signature", async () => {
    const { service } = setup();
    const res = await service.withdraw(IDENTITY_ID, base);
    expect(res.signature).toBe("sig-sponsor-sol");
    expect(res.status).toBe("confirmed");
    expect(res.networkFeeLamports).toBe("5000");
    expect(res.protocolFeeLamports).toBe("2500");
    expect(adapterMock.sponsoredWithdrawSolV3).toHaveBeenCalledTimes(1);
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][0]).toBe("pid_01HASH");
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][4]).toBe(2); // policy version
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][5]).toBe(5000n); // attested networkFee
    // ANT-635: the service omits treasury — the adapter derives the ["treasury"] PDA.
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][10]).toBeUndefined();
  });

  it("rejects a stale nonce before broadcasting", async () => {
    const { service } = setup();
    adapterMock.getNonce.mockResolvedValue(9n); // differs from dto.nonce=7
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects insufficient wallet balance (amount + network + protocol)", async () => {
    const { service } = setup();
    adapterMock.getBalanceOf.mockImplementation(async (addr: { toBase58: () => string } | string) => {
      const s = typeof addr === "string" ? addr : addr.toBase58();
      return s === RELAYER ? relayerBalance : 1000; // wallet has ~nothing
    });
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("503 and no broadcast when the relayer float is unfunded", async () => {
    const { service } = setup();
    relayerBalance = 0;
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ServiceUnavailableException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects an unknown/inactive credential", async () => {
    const { service, security } = setup();
    (security as unknown as { prisma: unknown }).prisma;
    const prisma = (service as unknown as { prisma: { authority: { findFirst: jest.Mock } } }).prisma;
    prisma.authority.findFirst.mockResolvedValue(null);
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects a garbage SPL mint with 400 (never 500) before broadcasting", async () => {
    const { service } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, asset: "!!!not-a-mint" })).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
    expect(adapterMock.sponsoredWithdrawTokenV3).not.toHaveBeenCalled();
  });

  it("routes token withdrawals through the token sponsor and requires an existing ATA", async () => {
    const { service } = setup();
    adapterMock.hasAccount.mockResolvedValue(false);
    await expect(service.withdraw(IDENTITY_ID, { ...base, asset: "USDCmint11111111111111111111111111111111" })).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawTokenV3).not.toHaveBeenCalled();

    adapterMock.hasAccount.mockResolvedValue(true);
    const res = await service.withdraw(IDENTITY_ID, { ...base, asset: "USDCmint11111111111111111111111111111111" });
    expect(res.signature).toBe("sig-sponsor-token");
    expect(adapterMock.sponsoredWithdrawTokenV3).toHaveBeenCalledTimes(1);
  });

  it("rejects drift beyond 120% of the quoted network fee without broadcasting", async () => {
    const { service, security } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, quotedNetworkFeeLamports: "1000" })).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
    // H1.v + H1.ii: drift pair with the exact contract keys.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "quote.drift_rejected",
      expect.objectContaining({ chain: "solana", entryPoint: "withdraw", quoted: "1000", attested: "5000" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ chain: "solana", entryPoint: "withdraw", cause: "drift", nonce: "7" }),
    );
  });

  it("accepts attestation at exactly 120% of the quote", async () => {
    // attested 5000 vs quoted 4167: 5000×100 == 500000 < 4167×120 == 500040 → passes.
    const { service } = setup();
    const res = await service.withdraw(IDENTITY_ID, { ...base, quotedNetworkFeeLamports: "4167" });
    expect(res.signature).toBe("sig-sponsor-sol");
    expect(adapterMock.sponsoredWithdrawSolV3).toHaveBeenCalledTimes(1);
  });

  it("rejects attestation one unit above the 120% boundary", async () => {
    // attested 5000 vs quoted 4166: 5000×100 == 500000 > 4166×120 == 499920 → rejects.
    const { service } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, quotedNetworkFeeLamports: "4166" })).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects an authorization lifetime beyond 600 seconds", async () => {
    const { service } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, expiry: 1_000_601 })).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects an unsupported fee policy version", async () => {
    const { service } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, feePolicyVersion: 99 })).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("rejects a token withdrawal exceeding the SPL balance", async () => {
    const { service } = setup();
    adapterMock.hasAccount.mockResolvedValue(true);
    await expect(
      service.withdraw(IDENTITY_ID, { ...base, asset: "USDCmint11111111111111111111111111111111", amount: "99999999" }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawTokenV3).not.toHaveBeenCalled();
  });

  it("logs reconciliation with formula-exact protocol fee", async () => {
    const { service, security } = setup();
    await service.withdraw(IDENTITY_ID, base);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "withdraw.reconciled",
      expect.objectContaining({
        networkFee: "5000",
        protocolFee: "2500",
        protocolFeeExpected: "2500",
        actualNetworkFee: "5000",
        overAttested: false,
      }),
    );
  });

  it("flags over-attestation beyond 120% of the actual network fee", async () => {
    const { service, security } = setup();
    // attested 5000 vs actual 4000: 5000×100 == 500000 > 4000×120 == 480000.
    adapterMock.parseTransaction.mockResolvedValueOnce({ signature: "sig", fee: 4000 });
    await service.withdraw(IDENTITY_ID, base);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "withdraw.reconciled",
      expect.objectContaining({ actualNetworkFee: "4000", overAttested: true }),
    );
    // H1.iii + H1.iv canonical rows with base-unit money strings.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "reconcile.over_attested",
      expect.objectContaining({
        chain: "solana",
        entryPoint: "withdraw",
        signature: "sig-sponsor-sol",
        attested: "5000",
        actual: "4000",
        expected: "4000",
        absorbed: "0",
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relayer.pnl",
      expect.objectContaining({
        chain: "solana",
        entryPoint: "withdraw",
        signature: "sig-sponsor-sol",
        absorbed: "0",
        attested: "5000",
        actual: "4000",
      }),
    );
  });

  it("emits relay.resolve_landed on confirmed sponsored withdraw", async () => {
    const { service, security } = setup();
    await service.withdraw(IDENTITY_ID, base);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relay.resolve_landed",
      expect.objectContaining({ chain: "solana", entryPoint: "withdraw", nonce: "7", signature: "sig-sponsor-sol" }),
    );
  });

  it("emits intent.rejected with a typed cause on stale nonce", async () => {
    const { service, security } = setup();
    adapterMock.getNonce.mockResolvedValue(9n); // differs from dto.nonce=7
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ chain: "solana", entryPoint: "withdraw", cause: "stale-nonce", nonce: "7" }),
    );
  });

  const executeBase = {
    target: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    metas: [
      { address: "AtAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAA", writable: true, signer: false },
      { address: SMART_ADDR, writable: false, signer: true },
    ],
    data: Buffer.from([3, 100, 0, 0, 0, 0, 0, 0, 0]).toString("base64url"),
    nonce: "7",
    expiry: 1_000_300,
    feePolicyVersion: 2,
    quotedNetworkFeeLamports: "10000",
    maxTotalFeeLamports: "27000",
    assertion: assertion as never,
  };

  it("execute broadcasts the generic call and returns the confirmed signature", async () => {
    const { service, security } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    const res = await service.execute(IDENTITY_ID, executeBase);
    expect(res.signature).toBe("sig-execute");
    expect(res.status).toBe("confirmed");
    expect(res.networkFeeLamports).toBe("10000");
    expect(res.protocolFeeLamports).toBe("5000");
    expect(adapterMock.sponsoredExecuteV3).toHaveBeenCalledTimes(1);
    const call = adapterMock.sponsoredExecuteV3.mock.calls[0];
    expect(call[0]).toBe("pid_01HASH");
    expect(call[5]).toBe(2); // policy version
    expect(call[6]).toBe(10000n); // attested networkFee
    expect(call[11]).toBeUndefined(); // ANT-635: adapter derives the ["treasury"] PDA
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "execute.submitted",
      expect.objectContaining({ networkFee: "10000", protocolFee: "5000", dataLen: 9, metaCount: 2 }),
    );
  });

  it("quoteExecute returns the shape-faithful network estimate plus policy", async () => {
    const { service } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    const q = await service.quoteExecute(IDENTITY_ID, {
      target: executeBase.target,
      metas: executeBase.metas,
      data: executeBase.data,
    });
    expect(BigInt(q.networkFeeLamports)).toBe(10000n);
    expect(q.protocolFeeBps).toBe(5000);
    expect(BigInt(q.totalFeeLamports)).toBe(15000n);
    // The estimate saw the real call shape (target + metas + data length).
    const shapeCall = adapterMock.estimateExecuteFee.mock.calls[0];
    expect(shapeCall[0]).toEqual(new MockPublicKey(executeBase.target));
    expect(shapeCall[1]).toHaveLength(2);
    expect(shapeCall[2]).toBe(9);
  });

  it("execute rejects the program itself as target", async () => {
    const { service } = setup();
    await expect(
      service.execute(IDENTITY_ID, { ...executeBase, target: "PidProgram1111111111111111111111111111111" }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredExecuteV3).not.toHaveBeenCalled();
  });

  it("execute rejects a call that does not delegate the PDA as signer", async () => {
    const { service } = setup();
    await expect(
      service.execute(IDENTITY_ID, {
        ...executeBase,
        metas: [{ address: "AtAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAA", writable: true, signer: false }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredExecuteV3).not.toHaveBeenCalled();
  });

  it("execute rejects drift beyond 120% of the quoted network fee", async () => {
    const { service } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(12001n); // 12001×100 > 10000×120
    await expect(service.execute(IDENTITY_ID, executeBase)).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredExecuteV3).not.toHaveBeenCalled();
  });

  it("execute rejects a total above the user-authorized maxTotalFee without broadcasting", async () => {
    const { service, security } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    await expect(
      service.execute(IDENTITY_ID, { ...executeBase, maxTotalFeeLamports: "14999" }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredExecuteV3).not.toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "execute.max_total_exceeded",
      expect.objectContaining({ totalFee: "15000", maxTotalFee: "14999" }),
    );
  });

  it("execute logs reconciliation under the execute namespace", async () => {
    const { service, security } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    adapterMock.parseTransaction.mockResolvedValueOnce({ signature: "sig-execute", fee: 10000 });
    await service.execute(IDENTITY_ID, executeBase);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "execute.reconciled",
      expect.objectContaining({
        networkFee: "10000",
        protocolFee: "5000",
        protocolFeeExpected: "5000",
        actualNetworkFee: "10000",
        overAttested: false,
      }),
    );
  });

  it("quote exposes the v2 canonical shape (contract-first field names)", async () => {
    const { service } = setup();
    const q = await service.quote(IDENTITY_ID);
    // Canonical six (ANT-544 §4.1 — Thomas integrates against these names).
    expect(q.networkFee).toBe("5000");
    expect(q.platformFee).toBe("2500");
    expect(q.feePolicyVersion).toBe(2);
    expect(q.totalFee).toBe("7500");
    expect(q.maxTotalFee).toBe("7500");
    expect(q.chainTime).toBe(1_000_000);
    // Compat aliases + policy introspection.
    expect(q.totalFeeLamports).toBe("7500");
    expect(q.protocolFeeLamports).toBe("2500");
    expect(q.suggestedMaxTotalFee).toBe("7500");
    expect(q.chainMinBaseUnits).toBe("0");
    expect(new Date(q.expiresAt).getTime() - new Date(q.quotedAt).getTime()).toBe(300_000);
  });

  it("withdraw rejects a total above the user-authorized maxTotalFee without broadcasting", async () => {
    const { service, security } = setup();
    await expect(
      service.withdraw(IDENTITY_ID, { ...base, maxTotalFeeLamports: "7499" }),
    ).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "withdraw.max_total_exceeded",
      expect.objectContaining({ totalFee: "7500", maxTotalFee: "7499" }),
    );
  });

  it("withdraw rejects a non-numeric maxTotalFee as a bad request", async () => {
    const { service } = setup();
    await expect(
      service.withdraw(IDENTITY_ID, { ...base, maxTotalFeeLamports: "unlimited" }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("quote omits the chain echo when the registry has no Solana row", async () => {
    const { service } = setup();
    const q = await service.quote(IDENTITY_ID);
    expect(q.chain).toBeUndefined();
  });

  it("quote echoes the active Solana chain when the registry has one", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockResolvedValue({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
    const q = await service.quote(IDENTITY_ID);
    expect(q.chain).toEqual({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
  });

  it("quote echoes the selected Solana chain when a selection is passed (ANT-626)", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockImplementation(async (selection?: string) => ({
      namespace: "solana",
      reference: selection === "testnet" ? SOLANA_TESTNET_REFERENCE : SOLANA_DEVNET_REFERENCE,
    }));
    const q = await service.quote(IDENTITY_ID, "testnet");
    expect(chains.solanaChain).toHaveBeenCalledWith("testnet");
    expect(q.chain).toEqual({ namespace: "solana", reference: SOLANA_TESTNET_REFERENCE });
  });

  it("quoteExecute echoes the selected Solana chain when a selection is passed (ANT-626)", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockImplementation(async (selection?: string) => ({
      namespace: "solana",
      reference: selection === "testnet" ? SOLANA_TESTNET_REFERENCE : SOLANA_DEVNET_REFERENCE,
    }));
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    const q = await service.quoteExecute(
      IDENTITY_ID,
      {
        target: executeBase.target,
        metas: executeBase.metas,
        data: executeBase.data,
      },
      "testnet",
    );
    expect(chains.solanaChain).toHaveBeenCalledWith("testnet");
    expect(q.chain).toEqual({ namespace: "solana", reference: SOLANA_TESTNET_REFERENCE });
  });

  it("quoteExecute echoes the active Solana chain when the registry has one", async () => {
    const { service } = setup();
    const chains = (service as unknown as { chains: { solanaChain: jest.Mock } }).chains;
    chains.solanaChain.mockResolvedValue({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    const q = await service.quoteExecute(IDENTITY_ID, {
      target: executeBase.target,
      metas: executeBase.metas,
      data: executeBase.data,
    });
    expect(q.chain).toEqual({ namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" });
  });

  it("quoteExecute omits the chain echo when the registry has no Solana row", async () => {
    const { service } = setup();
    adapterMock.estimateExecuteFee.mockResolvedValue(10000n);
    const q = await service.quoteExecute(IDENTITY_ID, {
      target: executeBase.target,
      metas: executeBase.metas,
      data: executeBase.data,
    });
    expect(q.chain).toBeUndefined();
  });

  it("emits typed rejection + quote.drift_rejected on fee drift (H-AC2/H-AC6)", async () => {
    const { service, security } = setup();
    adapterMock.estimateWithdrawFee.mockResolvedValueOnce(7000n);
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ entryPoint: "withdraw", cause: "drift" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "quote.drift_rejected",
      expect.objectContaining({ entryPoint: "withdraw", quoted: "5000", attested: "7000" }),
    );
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("emits over_attested + pnl on reconcile divergence, never rebroadcasts (H-AC4)", async () => {
    const { service, security } = setup();
    adapterMock.parseTransaction.mockResolvedValueOnce({ signature: "sig", fee: 1000 });
    const res = await service.withdraw(IDENTITY_ID, base);
    expect(res.status).toBe("confirmed");
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "reconcile.over_attested",
      expect.objectContaining({ entryPoint: "withdraw", attested: "5000", actual: "1000" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relayer.pnl",
      expect.objectContaining({ entryPoint: "withdraw", absorbed: "0" }),
    );
    expect(adapterMock.sponsoredWithdrawSolV3).toHaveBeenCalledTimes(1);
  });

  it("resolves a duplicate claim without submission via chain state (H-AC7)", async () => {
    const { service, idempotency } = setup();
    idempotency.claimSlot.mockResolvedValue({ decision: "duplicate", signature: null });
    // Validation reads nonce 7; the crashed attempt consumed it (now 8) and the
    // history confirms ⇒ proven landed, no rebroadcast.
    adapterMock.getNonce.mockResolvedValueOnce(7n).mockResolvedValue(8n);
    adapterMock.getHistory.mockResolvedValue([{ signature: "sig-h", err: null }]);
    const landed = await service.withdraw(IDENTITY_ID, base);
    expect(landed).toMatchObject({ signature: "sig-h", status: "confirmed" });
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
    // Nonce unconsumed ⇒ proven non-landing ⇒ the single allowed broadcast.
    adapterMock.getNonce.mockReset();
    adapterMock.getNonce.mockResolvedValue(7n);
    jest.clearAllMocks();
    idempotency.claimSlot.mockResolvedValue({ decision: "duplicate", signature: null });
    const fresh = await service.withdraw(IDENTITY_ID, base);
    expect(fresh.signature).toBe("sig-sponsor-sol");
    expect(adapterMock.sponsoredWithdrawSolV3).toHaveBeenCalledTimes(1);
  });
});

describe("SponsoredWithdrawService — DB fee legs ignored (ANT-743 pure percentage)", () => {
  const dbFees = {
    minFeeFor: jest.fn<Promise<{ minFee: bigint; version: number; bps: number }>, []>(),
    minFeeForVersion: jest.fn<Promise<{ minFee: bigint; bps: number }>, []>(),
    checkSubmitVersion: jest.fn<Promise<unknown>, []>(),
  };

  beforeEach(() => {
    dbFees.minFeeFor.mockResolvedValue({ minFee: 50_000n, version: 2, bps: 5000 });
    dbFees.minFeeForVersion.mockResolvedValue({ minFee: 50_000n, bps: 5000 });
    dbFees.checkSubmitVersion.mockResolvedValue({ ok: true as const });
  });

  it("quote ignores the DB MIN_FEE leg (network 5000 → platform 2500 pure 50%)", async () => {
    const { service } = setup(dbFees);
    const q = await service.quote(IDENTITY_ID);
    expect(q.feePolicyVersion).toBe(2);
    expect(q.chainMinBaseUnits).toBe("0");
    expect(q.platformFee).toBe("2500");
    expect(q.totalFee).toBe("7500");
    expect(q.maxTotalFee).toBe("7500");
  });

  it("withdraw rejects a superseded version as StaleQuote (410) with the typed cause", async () => {
    dbFees.checkSubmitVersion.mockResolvedValue({
      ok: false as const,
      code: "StaleQuote",
      status: 410 as const,
      message: "Fee policy superseded — re-quote and try again",
    });
    const { service, security } = setup(dbFees);
    const err = await service.withdraw(IDENTITY_ID, { ...base, feePolicyVersion: 1 }).catch((e) => e);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: "StaleQuote" });
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      expect.anything(),
      expect.objectContaining({ entryPoint: "withdraw", cause: "policy-unknown" }),
    );
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
  });

  it("withdraw accepts one version back with a warning and settles under the signed version", async () => {
    dbFees.checkSubmitVersion.mockResolvedValue({ ok: true as const, warning: "Quote uses fee-policy v1; current is v2" });
    dbFees.minFeeForVersion.mockResolvedValue({ minFee: 0n, bps: 5000 });
    const { service } = setup(dbFees);
    // v1 math: network 5000 → platform 2500 → total 7500 ≤ maxTotalFee 22000.
    const out = await service.withdraw(IDENTITY_ID, { ...base, feePolicyVersion: 1 });
    expect(out.signature).toBe("sig-sponsor-sol");
    expect(out.protocolFeeLamports).toBe("2500");
    expect(out.feePolicyWarning).toMatch(/v1.*v2/);
  });
});
