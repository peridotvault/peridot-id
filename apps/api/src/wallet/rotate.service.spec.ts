import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { RotateService } from "./rotate.service";
import { mockSecurity, mockIdempotency, mockBreaker, mockRevocations, solanaRelayerConfig, minimalChainsStub, COSE_HEX } from "../../test/factories";
import { coseToCompressedSecp256r1 } from "../credentials/cose";

const IDENTITY_ID = "pid_01HASH";
const SMART_ADDR = "CNostmskLqp9bRX2StVVQ7cTJymAgNRweH1UxMsJQib7";
const RELAYER = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";

class MockPublicKey {
  constructor(public readonly addr: string) {}
  toBase58(): string {
    return this.addr;
  }
}

const NEW_KEY_HEX = Buffer.from(coseToCompressedSecp256r1(Buffer.from(COSE_HEX, "hex"))).toString("hex");
let rotatedKeyHex = NEW_KEY_HEX;

const adapterMock = {
  isActivated: jest.fn(async () => true),
  chainTime: jest.fn(async () => 1_000_000),
  getNonce: jest.fn(async () => 4n),
  getNonceOf: jest.fn(async () => 4n),
  submitRotateAuthorityTx: jest.fn(async () => "sig-rotate"),
  getAuthority: jest.fn(async () => Buffer.from(rotatedKeyHex, "hex")),
  getAuthorityOf: jest.fn(async () => Buffer.from(rotatedKeyHex, "hex")),
  parseTransaction: jest.fn(async () => ({ signature: "sig", fee: 5000 })),
};

jest.mock("@peridotvault/pid-solana", () => ({
  Keypair: { fromSecretKey: jest.fn(() => ({ publicKey: new MockPublicKey(RELAYER) })) },
  PublicKey: MockPublicKey,
  SolanaAdapter: jest.fn(() => adapterMock),
  SolanaRpc: jest.fn(() => ({})),
  fromHex: jest.fn((hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))),
  b64urlToBytes: jest.fn((s: string) => Uint8Array.from(Buffer.from(s, "base64url"))),
}));

const assertion = {
  id: "cred-old",
  signature: "A".repeat(86),
  authenticatorData: "B".repeat(50),
  clientDataJSON: "C".repeat(60),
};

function setup() {
  const config = solanaRelayerConfig();
  const security = mockSecurity();
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => ({
        id: "chain-1",
        pid: IDENTITY_ID,
        address: SMART_ADDR,
        accountType: "smart_account",
        status: "active",
      })),
    },
    authority: {
      findFirst: jest.fn(async (args: { where: { credentialId: string } }) =>
        args.where.credentialId === "cred-missing"
          ? null
          : { id: `auth-${args.where.credentialId}`, publicKey: Buffer.from(COSE_HEX, "hex"), status: "active" },
      ),
      update: jest.fn(async (args: unknown) => args),
    },
  };
  const idempotency = mockIdempotency();
  const service = new RotateService(prisma as never, config as never, security as never, minimalChainsStub() as never, idempotency as never, mockBreaker() as never, mockRevocations() as never);
  return { service, prisma, security, idempotency };
}

const base = {
  oldCredentialId: "cred-old",
  newCredentialId: "cred-new",
  nonce: "4",
  expiry: 1_000_300,
  assertion: assertion as never,
};

beforeEach(() => {
  jest.clearAllMocks();
  rotatedKeyHex = NEW_KEY_HEX;
  adapterMock.isActivated.mockResolvedValue(true);
  adapterMock.getNonce.mockResolvedValue(4n);
});

describe("RotateService", () => {
  it("rotates on-chain then revokes the old credential", async () => {
    const { service, prisma, security } = setup();
    const res = await service.rotate(IDENTITY_ID, base);
    expect(res.signature).toBe("sig-rotate");
    expect(res.status).toBe("confirmed");
    expect(adapterMock.submitRotateAuthorityTx).toHaveBeenCalledTimes(1);
    expect(prisma.authority.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "revoked" }) }),
    );
    expect(security.log).toHaveBeenCalledWith(IDENTITY_ID, "credential.rotated", expect.any(Object));
  });

  it("rejects when the assertion is not from the current credential", async () => {
    const { service } = setup();
    await expect(
      service.rotate(IDENTITY_ID, { ...base, assertion: { ...assertion, id: "cred-other" } as never }),
    ).rejects.toThrow(BadRequestException);
    expect(adapterMock.submitRotateAuthorityTx).not.toHaveBeenCalled();
  });

  it("rejects a stale nonce before broadcasting", async () => {
    const { service, security } = setup();
    adapterMock.getNonce.mockResolvedValue(9n);
    await expect(service.rotate(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(adapterMock.submitRotateAuthorityTx).not.toHaveBeenCalled();
    // H1.ii: typed rejection with the exact contract keys.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ chain: "solana", entryPoint: "rotate", cause: "stale-nonce", nonce: "4" }),
    );
  });

  it("emits rotation.confirmed with chain + latencyMs and chains the rotated row", async () => {
    const { service, security } = setup();
    const res = await service.rotate(IDENTITY_ID, base);
    expect(res.signature).toBe("sig-rotate");
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relay.resolve_landed",
      expect.objectContaining({ chain: "solana", entryPoint: "rotate", nonce: "4", signature: "sig-rotate" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "rotation.confirmed",
      expect.objectContaining({ chain: "solana", signature: "sig-rotate", nonce: "4" }),
    );
    const confirmed = (security.log as jest.Mock).mock.calls.find((c) => c[1] === "rotation.confirmed");
    expect(Number(confirmed[2].latencyMs)).not.toBeNaN();
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "credential.rotated",
      expect.objectContaining({ chain: "solana", signature: "sig-rotate" }),
    );
  });

  it("emits credential.rotation.unconfirmed with the chain key", async () => {
    const { service, security } = setup();
    rotatedKeyHex = "03" + "cd".repeat(32); // chain never shows the new key
    await expect(service.rotate(IDENTITY_ID, base)).rejects.toThrow(ServiceUnavailableException);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "credential.rotation.unconfirmed",
      expect.objectContaining({ chain: "solana", signature: "sig-rotate" }),
    );
  }, 30000);

  it("rejects an over-TTL expiry", async () => {
    const { service } = setup();
    await expect(service.rotate(IDENTITY_ID, { ...base, expiry: 1_000_601 })).rejects.toThrow(BadRequestException);
    expect(adapterMock.submitRotateAuthorityTx).not.toHaveBeenCalled();
  });

  it("keeps the old credential active when confirmation never lands", async () => {
    const { service, prisma } = setup();
    rotatedKeyHex = "03" + "cd".repeat(32); // chain never shows the new key
    await expect(service.rotate(IDENTITY_ID, base)).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.authority.update).not.toHaveBeenCalled();
  }, 30000);

  it("emits rotation latency + unconfirmed event on the 503 path (H1.vi)", async () => {
    const { service, security } = setup();
    rotatedKeyHex = "03" + "cd".repeat(32); // chain never shows the new key
    await expect(service.rotate(IDENTITY_ID, base)).rejects.toThrow(/not confirmed on-chain yet/);
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "rotation.confirmed",
      expect.objectContaining({ signature: "sig-rotate" }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "credential.rotation.unconfirmed",
      expect.objectContaining({ signature: "sig-rotate" }),
    );
  }, 30000);

  it("claims the duplicate slot before the double-rotation guard (F1)", async () => {
    const { service, idempotency } = setup();
    const order: string[] = [];
    idempotency.claimSlot.mockImplementation(async () => {
      order.push("claim");
      return { decision: "proceed", signature: null };
    });
    idempotency.assertNoInflightRotation.mockImplementation(async () => {
      order.push("guard");
    });
    await service.rotate(IDENTITY_ID, base);
    expect(order).toEqual(["claim", "guard"]);
  });

  it("skips the guard on the duplicate-slot resolve path (F1)", async () => {
    const { service, idempotency } = setup();
    // Chain already shows the new authority: idempotent completion, no guard.
    idempotency.claimSlot.mockResolvedValue({ decision: "duplicate", signature: "sig-old" });
    const res = await service.rotate(IDENTITY_ID, base);
    expect(res).toEqual({ signature: "sig-old", status: "confirmed" });
    expect(idempotency.assertNoInflightRotation).not.toHaveBeenCalled();
    expect(adapterMock.submitRotateAuthorityTx).not.toHaveBeenCalled();
  });
});
