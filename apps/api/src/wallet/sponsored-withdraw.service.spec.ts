import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { SponsoredWithdrawService } from "./sponsored-withdraw.service";
import { mockSecurity, solanaRelayerConfig, minimalChainsStub, COSE_HEX, TREASURY } from "../../test/factories";


const ACCOUNT_ID = "50997bcf-f3e3-406b-bc77-7108593ef5cb";
const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const DEST = "DeSt1111111111111111111111111111111111111";

class MockPublicKey {
  constructor(public readonly addr: string) {}
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
  parseTransaction: jest.fn(async () => ({ signature: "sig", fee: 5000 })),
  sponsoredWithdrawSolV3: jest.fn(async () => "sig-sponsor-sol") as jest.Mock,
  sponsoredWithdrawTokenV3: jest.fn(async () => "sig-sponsor-token") as jest.Mock,
  estimateExecuteFee: jest.fn(async () => 10000n) as jest.Mock,
  sponsoredExecuteV3: jest.fn(async () => "sig-execute") as jest.Mock,
  waitForConfirmation: jest.fn(async () => "confirmed" as const),
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

function setup() {
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
  const service = new SponsoredWithdrawService(prisma as never, config as never, security as never, chains as never);
  return { service, security };
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
  feePolicyVersion: 1,
  quotedNetworkFeeLamports: "5000",
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
    expect(q.feePolicyVersion).toBe(1);
    expect(q.chainTime).toBe(1_000_000);
  });

  it("quote rejects a not-activated wallet", async () => {
    const { service } = setup();
    adapterMock.isActivated.mockResolvedValue(false);
    await expect(service.quote(IDENTITY_ID)).rejects.toThrow(ConflictException);
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
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][4]).toBe(1); // policy version
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][5]).toBe(5000n); // attested networkFee
    // treasury() falls back to the relayer pubkey by default (production).
    expect(adapterMock.sponsoredWithdrawSolV3.mock.calls[0][10]).toEqual(new MockPublicKey(RELAYER));
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
    const { service } = setup();
    await expect(service.withdraw(IDENTITY_ID, { ...base, quotedNetworkFeeLamports: "1000" })).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSolV3).not.toHaveBeenCalled();
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
    await expect(service.withdraw(IDENTITY_ID, { ...base, feePolicyVersion: 2 })).rejects.toThrow(BadRequestException);
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
    feePolicyVersion: 1,
    quotedNetworkFeeLamports: "10000",
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
    expect(call[5]).toBe(1); // policy version
    expect(call[6]).toBe(10000n); // attested networkFee
    expect(call[11]).toEqual(new MockPublicKey(RELAYER)); // treasury falls back to relayer
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "execute.submitted",
      expect.objectContaining({ networkFee: "10000", protocolFee: "5000" }),
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
});
