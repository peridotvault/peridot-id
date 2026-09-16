import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { RotateService } from "./rotate.service";
import { mockSecurity, solanaRelayerConfig, COSE_HEX } from "../../test/factories";
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
  submitRotateAuthorityTx: jest.fn(async () => "sig-rotate"),
  getAuthority: jest.fn(async () => Buffer.from(rotatedKeyHex, "hex")),
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
  const service = new RotateService(prisma as never, config as never, security as never);
  return { service, prisma, security };
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
    const { service } = setup();
    adapterMock.getNonce.mockResolvedValue(9n);
    await expect(service.rotate(IDENTITY_ID, base)).rejects.toThrow(ConflictException);
    expect(adapterMock.submitRotateAuthorityTx).not.toHaveBeenCalled();
  });

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
});
