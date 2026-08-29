import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CredentialService } from "./credential.service";

const ACCOUNT_ID = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";

// A valid COSE_Key (ES256) with x = 0x11*32, y = 0x22*32 → compressed 0x02 || x.
const COSE_KEY = Buffer.concat([
  Buffer.from([0xa4, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  Buffer.alloc(32, 0x11),
  Buffer.from([0x22, 0x58, 0x20]),
  Buffer.alloc(32, 0x22),
]);
const COMPRESSED_B64 = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0x11)]).toString("base64url");

function authority(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "auth-1",
    accountId: ACCOUNT_ID,
    type: "secp256r1",
    publicKey: COSE_KEY,
    credentialId: "cred-1",
    status: "active",
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    lastUsedAt: null,
    ...overrides,
  };
}

function setup() {
  const config = {
    get: jest.fn((key: string) => (key === "WEBAUTHN_RP_ID" ? "localhost" : key === "WEBAUTHN_RP_NAME" ? "PeridotID" : key === "WEBAUTHN_ORIGINS" ? "http://localhost:3301" : undefined)),
  };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    peridotAccount: {
      findFirst: jest.fn(async () => ({ id: ACCOUNT_ID, identityId: "pid_01HASH", status: "active" })),
    },
    authority: {
      findMany: jest.fn(async () => [] as any),
      findFirst: jest.fn(async () => null as any),
      create: jest.fn(async () => authority({ id: "auth-new" })),
      update: jest.fn(async () => authority({ lastUsedAt: new Date() })),
      count: jest.fn(async () => 2),
    },
    credentialChallenge: {
      findFirst: jest.fn(async () => null as any),
      create: jest.fn(async (args: { data: { accountId: string; kind: string; challenge: string } }) => ({
        id: "challenge-1",
        ...args.data,
      })),
      update: jest.fn(async () => ({})),
    },
  };
  const service = new CredentialService(prisma as never, config as never, security as never);
  return { service, prisma, config, security };
}

describe("CredentialService", () => {
  it("list returns active authorities as public views", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([authority()]);

    const views = await service.list("pid_01HASH");

    expect(views[0]).toEqual({
      id: "auth-1",
      type: "secp256r1",
      credentialId: "cred-1",
      publicKey: COMPRESSED_B64,
      createdAt: expect.any(Date),
      lastUsedAt: null,
    });
    // No raw COSE/key material leaks beyond the compressed pubkey (public data).
    expect(views[0]).not.toHaveProperty("rawPublicKey");
  });

  it("registerStart for a first credential issues a registration challenge (no approval)", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([]);

    const result = await service.registerStart("pid_01HASH");

    expect(result.isAdditional).toBe(false);
    expect(result.approval).toBeNull();
    expect(result.options.challenge).toBeDefined();
    expect(result.options.pubKeyCredParams[0].alg).toBe(-7); // ES256 = secp256r1
    expect(prisma.credentialChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "registration", isAdditional: false, accountId: ACCOUNT_ID }),
      }),
    );
  });

  it("registerStart for a second credential requires existing-credential approval", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([authority()]);

    const result = await service.registerStart("pid_01HASH");

    expect(result.isAdditional).toBe(true);
    expect(result.approval).not.toBeNull();
    expect(prisma.credentialChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isAdditional: true, approvalChallenge: expect.any(String) }),
      }),
    );
  });

  it("registerFinish rejects a replayed (consumed) challenge", async () => {
    const { service, prisma } = setup();
    prisma.credentialChallenge.findFirst.mockResolvedValue(null); // consumed → gone

    await expect(
      service.registerFinish("pid_01HASH", {
        registrationId: "11111111-1111-4111-8111-111111111111",
        credential: { id: "x", rawId: "x", response: { clientDataJSON: "y", attestationObject: "z" } },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("registerFinish rejects an OAuth-only second credential (no approval)", async () => {
    const { service, prisma } = setup();
    prisma.credentialChallenge.findFirst.mockResolvedValue({
      id: "c1",
      accountId: ACCOUNT_ID,
      kind: "registration",
      challenge: "challenge-a",
      approvalChallenge: "approval-a",
      isAdditional: true,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.registerFinish("pid_01HASH", {
        registrationId: "c1",
        credential: { id: "new-cred", rawId: "new-cred", response: { clientDataJSON: "y", attestationObject: "z" } },
      }),
    ).rejects.toThrow(BadRequestException); // "Persetujuan kredensial yang ada diperlukan"

    expect(securityLog(service)).toHaveBeenCalledWith("pid_01HASH", "credential.register.rejected", expect.any(Object), ACCOUNT_ID);
  });

  it("registerFinish rejects a reused credentialId", async () => {
    const { service, prisma } = setup();
    prisma.authority.findFirst.mockResolvedValue(authority()); // existing credential with same id
    prisma.credentialChallenge.findFirst.mockResolvedValue({
      id: "c1",
      accountId: ACCOUNT_ID,
      kind: "registration",
      challenge: "challenge-a",
      approvalChallenge: null,
      isAdditional: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.registerFinish("pid_01HASH", {
        registrationId: "c1",
        credential: { id: "cred-1", rawId: "cred-1", response: { clientDataJSON: "y", attestationObject: "z" } },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("revoke rejects removing the last remaining authority", async () => {
    const { service, prisma } = setup();
    prisma.authority.findFirst.mockResolvedValue(authority());
    prisma.authority.count.mockResolvedValue(1); // only one active

    await expect(service.revoke("pid_01HASH", "auth-1")).rejects.toThrow(BadRequestException);
    expect(prisma.authority.update).not.toHaveBeenCalled();
  });

  it("revoke revokes a non-last authority and logs a security event", async () => {
    const { service, prisma, security } = setup();
    prisma.authority.findFirst.mockResolvedValue(authority());
    prisma.authority.count.mockResolvedValue(2);
    prisma.authority.update.mockResolvedValue(authority({ status: "revoked" }));

    const view = await service.revoke("pid_01HASH", "auth-1");

    expect(prisma.authority.update).toHaveBeenCalledWith({
      where: { id: "auth-1" },
      data: { status: "revoked" },
    });
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "credential.revoked", expect.any(Object), ACCOUNT_ID);
    expect(view.id).toBe("auth-1");
  });

  it("revoke throws NotFound for an authority that is not the account's own", async () => {
    const { service, prisma } = setup();
    prisma.authority.findFirst.mockResolvedValue(null);

    await expect(service.revoke("pid_01HASH", "auth-x")).rejects.toThrow(NotFoundException);
  });

  it("authenticateStart fails when no credential is registered", async () => {
    const { service } = setup();

    await expect(service.authenticateStart("pid_01HASH")).rejects.toThrow(BadRequestException);
  });

  it("authenticateFinish rejects an unknown credential", async () => {
    const { service, prisma } = setup();
    prisma.credentialChallenge.findFirst.mockResolvedValue({
      id: "c1",
      accountId: ACCOUNT_ID,
      kind: "authentication",
      challenge: "challenge-a",
      approvalChallenge: null,
      isAdditional: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.authority.findFirst.mockResolvedValue(null); // unknown credential

    await expect(
      service.authenticateFinish("pid_01HASH", {
        authenticationId: "c1",
        credential: { id: "nope", rawId: "nope", response: { clientDataJSON: "y", authenticatorData: "a", signature: "s" } },
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

function securityLog(service: CredentialService): jest.Mock {
  return (service as unknown as { security: { log: jest.Mock } }).security.log;
}