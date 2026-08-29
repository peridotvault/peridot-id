import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CredentialService } from "../credentials/credential.service";

const ACCOUNT_ID = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";
const COSE = Buffer.concat([
  Buffer.from([0xa4, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  Buffer.alloc(32, 0x11),
  Buffer.from([0x22, 0x58, 0x20]),
  Buffer.alloc(32, 0x22),
]);

function authority(id: string, status = "active") {
  return {
    id,
    accountId: ACCOUNT_ID,
    type: "secp256r1",
    publicKey: COSE,
    credentialId: `cred-${id}`,
    status,
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    lastUsedAt: null,
  };
}

function challenge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "challenge-1",
    accountId: ACCOUNT_ID,
    kind: "registration",
    challenge: "challenge-a",
    approvalChallenge: "approval-a",
    isAdditional: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function setup() {
  const config = {
    get: jest.fn((key: string) => (key === "WEBAUTHN_RP_ID" ? "localhost" : key === "WEBAUTHN_RP_NAME" ? "PeridotID" : key === "WEBAUTHN_ORIGINS" ? "http://localhost:3301" : undefined)),
  };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    peridotAccount: { findFirst: jest.fn(async () => ({ id: ACCOUNT_ID, identityId: "pid_01HASH", status: "active" }) as any) },
    authority: {
      findMany: jest.fn(async () => [] as any),
      findFirst: jest.fn(async () => null as any),
      create: jest.fn(async () => authority("auth-b")),
      update: jest.fn(async () => authority("auth-a", "revoked")),
      count: jest.fn(async () => 2),
    },
    credentialChallenge: {
      findFirst: jest.fn(async () => null as any),
      create: jest.fn(async (args: { data: { accountId: string; kind: string; challenge: string } }) => ({ id: "c1", ...args.data })),
      update: jest.fn(async () => ({})),
    },
  };
  const service = new CredentialService(prisma as never, config as never, security as never);
  return { service, prisma, security };
}

describe("Recovery & multi-device (task 008)", () => {
  it("multiple active credentials coexist — a second passkey can be listed alongside the first", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([authority("auth-a"), authority("auth-b")]);

    const views = await service.list("pid_01HASH");

    expect(views).toHaveLength(2);
    expect(views.map((v) => v.credentialId)).toEqual(["cred-auth-a", "cred-auth-b"]);
  });

  it("registerStart for a second credential requires existing-credential approval (multi-device)", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([authority("auth-a")]);

    const result = await service.registerStart("pid_01HASH");

    expect(result.isAdditional).toBe(true);
    expect(result.approval).not.toBeNull();
  });

  it("a revoked credential cannot approve adding another (abuse)", async () => {
    const { service, prisma, security } = setup();
    prisma.credentialChallenge.findFirst.mockResolvedValue(challenge());
    prisma.authority.findFirst.mockResolvedValue(null); // approver lookup finds nothing (revoked/excluded)

    await expect(
      service.registerFinish("pid_01HASH", {
        registrationId: "c1",
        credential: { id: "new-cred", rawId: "new-cred", response: { clientDataJSON: "y", attestationObject: "z" } },
        approval: { id: "cred-auth-a", rawId: "x", response: { clientDataJSON: "y", authenticatorData: "a", signature: "s" } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "credential.register.rejected", expect.any(Object), ACCOUNT_ID);
  });

  it("revoking one credential keeps the wallet usable via the other (lost-device flow)", async () => {
    const { service, prisma } = setup();
    prisma.authority.findFirst.mockResolvedValue(authority("auth-a"));
    prisma.authority.count.mockResolvedValue(2);
    prisma.authority.update.mockResolvedValue(authority("auth-a", "revoked"));

    const view = await service.revoke("pid_01HASH", "auth-a");

    expect(view.id).toBe("auth-a");
    expect(prisma.authority.update).toHaveBeenCalledWith({ where: { id: "auth-a" }, data: { status: "revoked" } });
  });

  it("revoking the last remaining credential is impossible (all-credentials-lost is unrecoverable)", async () => {
    const { service, prisma } = setup();
    prisma.authority.findFirst.mockResolvedValue(authority("auth-a"));
    prisma.authority.count.mockResolvedValue(1);

    await expect(service.revoke("pid_01HASH", "auth-a")).rejects.toThrow(BadRequestException);
  });

  it("a revoked credential no longer appears in the list and cannot authenticate", async () => {
    const { service, prisma } = setup();
    prisma.authority.findMany.mockResolvedValue([authority("auth-b")]); // auth-a revoked → gone

    const views = await service.list("pid_01HASH");
    expect(views).toHaveLength(1);
    expect(views[0].credentialId).toBe("cred-auth-b");

    // authenticateFinish with the revoked credential's id → rejected
    prisma.credentialChallenge.findFirst.mockResolvedValue({ id: "c1", accountId: ACCOUNT_ID, kind: "authentication", challenge: "c", approvalChallenge: null, isAdditional: false, expiresAt: new Date(Date.now() + 60_000) });
    prisma.authority.findFirst.mockResolvedValue(null);
    await expect(
      service.authenticateFinish("pid_01HASH", { authenticationId: "c1", credential: { id: "cred-auth-a", rawId: "x", response: { clientDataJSON: "y", authenticatorData: "a", signature: "s" } } }),
    ).rejects.toThrow(BadRequestException);
  });

  it("get/list throws NotFound when the account does not exist", async () => {
    const { service, prisma } = setup();
    prisma.peridotAccount.findFirst.mockResolvedValue(null as any);

    await expect(service.list("pid_nobody")).rejects.toThrow(NotFoundException);
  });
});