import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { SponsoredWithdrawService } from "./sponsored-withdraw.service";

const ACCOUNT_ID = "50997bcf-f3e3-406b-bc77-7108593ef5cb";
const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const TREASURY = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
const DEST = "DeSt1111111111111111111111111111111111111";
const COSE_HEX =
  "a5010203262001215820c728cac553ac9c7e6741694959adfbc1b5466df7071c8ea40fa05782c9628b8422582074d2fa89ce2b706497759bb98da015280bb379675f3476a378a6ce8a220ba639";

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
  sponsoredWithdrawSol: jest.fn(async () => "sig-sponsor-sol") as jest.Mock,
  sponsoredWithdrawToken: jest.fn(async () => "sig-sponsor-token") as jest.Mock,
  waitForConfirmation: jest.fn(async () => "confirmed" as const),
};

jest.mock("@peridotvault/pid-solana", () => ({
  Keypair: { fromSecretKey: jest.fn(() => ({ publicKey: new MockPublicKey(RELAYER) })) },
  PublicKey: MockPublicKey,
  SolanaAdapter: jest.fn(() => adapterMock),
  SolanaRpc: jest.fn(() => ({})),
  fromHex: jest.fn((hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))),
  b64urlToBytes: jest.fn((s: string) => Uint8Array.from(Buffer.from(s, "base64url"))),
}));

function setup() {
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const values: Record<string, unknown> = { PID_SOLANA_RPC_URL: "https://api.devnet.solana.com", PID_ACTIVATION_MARGIN_RATE: "0.5" };
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
    pidAccount: {
      findFirst: jest.fn(async () => ({
        id: ACCOUNT_ID,
        identityId: IDENTITY_ID,
        status: "active",
        chainAccounts: [
          { id: "chain-1", accountId: ACCOUNT_ID, accountType: "smart_account", address: SMART_ADDR, ...{} },
        ],
      })),
    },
    authority: { findFirst: jest.fn(async () => ({ id: "auth-1", publicKey: Buffer.from(COSE_HEX, "hex"), accountId: ACCOUNT_ID, status: "active", credentialId: "cred-1" })) },
  };
  const service = new SponsoredWithdrawService(prisma as never, config as never, security as never);
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
  relayFeeLamports: (5000n + (5000n * 500n) / 1000n).toString(), // 7500
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
  adapterMock.sponsoredWithdrawSol.mockResolvedValue("sig-sponsor-sol");
});

describe("SponsoredWithdrawService", () => {
  it("quote returns the fair relay fee (fee × (1 + margin)) and chain time", async () => {
    const { service } = setup();
    const q = await service.quote(IDENTITY_ID);
    expect(BigInt(q.relayFeeLamports)).toBe(7500n);
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
    expect(adapterMock.sponsoredWithdrawSol).toHaveBeenCalledTimes(1);
    expect(adapterMock.sponsoredWithdrawSol.mock.calls[0][0]).toBe(ACCOUNT_ID);
    // treasury() falls back to the relayer pubkey by default (production).
    expect(adapterMock.sponsoredWithdrawSol.mock.calls[0][9]).toEqual(new MockPublicKey(RELAYER));
  });

  it("rejects a stale nonce before broadcasting", async () => {
    const { service } = setup();
    adapterMock.getNonce.mockResolvedValue(9n); // differs from dto.nonce=7
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(adapterMock.sponsoredWithdrawSol).not.toHaveBeenCalled();
  });

  it("rejects insufficient wallet balance", async () => {
    const { service } = setup();
    adapterMock.getBalanceOf.mockImplementation(async (addr: { toBase58: () => string } | string) => {
      const s = typeof addr === "string" ? addr : addr.toBase58();
      return s === RELAYER ? relayerBalance : 1000; // wallet has ~nothing
    });
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSol).not.toHaveBeenCalled();
  });

  it("503 and no broadcast when the relayer float is unfunded", async () => {
    const { service } = setup();
    relayerBalance = 0;
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(ServiceUnavailableException);
    expect(adapterMock.sponsoredWithdrawSol).not.toHaveBeenCalled();
  });

  it("rejects an unknown/inactive credential", async () => {
    const { service, security } = setup();
    (security as unknown as { prisma: unknown }).prisma;
    const prisma = (service as unknown as { prisma: { authority: { findFirst: jest.Mock } } }).prisma;
    prisma.authority.findFirst.mockResolvedValue(null);
    await expect(service.withdraw(IDENTITY_ID, base)).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawSol).not.toHaveBeenCalled();
  });

  it("routes token withdrawals through the token sponsor and requires an existing ATA", async () => {
    const { service } = setup();
    adapterMock.hasAccount.mockResolvedValue(false);
    await expect(service.withdraw(IDENTITY_ID, { ...base, asset: "USDCmint11111111111111111111111111111111" })).rejects.toThrow(BadRequestException);
    expect(adapterMock.sponsoredWithdrawToken).not.toHaveBeenCalled();

    adapterMock.hasAccount.mockResolvedValue(true);
    const res = await service.withdraw(IDENTITY_ID, { ...base, asset: "USDCmint11111111111111111111111111111111" });
    expect(res.signature).toBe("sig-sponsor-token");
    expect(adapterMock.sponsoredWithdrawToken).toHaveBeenCalledTimes(1);
  });
});