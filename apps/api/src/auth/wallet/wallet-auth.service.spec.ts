import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SecurityEventService } from "../../security/security-event.service";
import { ClaimService } from "../claim.service";
import { SsoService } from "../sso.service";
import { UsageService } from "../../usage/usage.service";
import { WalletAuthService } from "./wallet-auth.service";
import { verifyWalletSignature } from "./wallet-signature";

jest.mock("./wallet-signature", () => ({
  normalizeWalletAddress: (_ns: string, address: string) => (address.startsWith("bad") ? null : address),
  verifyWalletSignature: jest.fn(),
}));

const verifyMock = verifyWalletSignature as jest.MockedFunction<typeof verifyWalletSignature>;

function challengeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    namespace: "solana",
    reference: "mainnet-beta",
    address: "SoLanaAddress",
    action: "login",
    pid: null,
    origin: "https://app.example",
    message: "PeridotID wants you to sign in",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function setup() {
  const prisma = {
    loginProvider: {
      findUnique: jest.fn(async () => ({ isAvailable: true, protocol: "wallet_signature" }) as any),
      findMany: jest.fn(async () => [{ code: "phantom" }, { code: "metamask" }] as any),
    },
    walletAuthChallenge: {
      create: jest.fn(async ({ data }: any) => ({ id: "ch-1", ...data })),
      findUnique: jest.fn(async () => challengeRow() as any),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    identityCredential: {
      findUnique: jest.fn(async () => null as any),
      findMany: jest.fn(async () => [] as any),
      create: jest.fn(async ({ data }: any) => ({ id: "cred-1", linkedAt: new Date(), lastLoginAt: null, ...data })),
      update: jest.fn(async () => ({}) as any),
      count: jest.fn(async () => 2),
      delete: jest.fn(async () => ({}) as any),
    },
  };
  const security = { log: jest.fn(async () => undefined) };
  const claim = { mintCredential: jest.fn(async () => "ct_1") };
  const sso = {
    resolveReturnTo: jest.fn(async (returnTo?: string, clientId?: string) =>
      returnTo ? { redirectTo: returnTo, clientId: clientId ?? "pidapp_x", isVerified: true } : null,
    ),
    requireVerifiedForAutoIssue: jest.fn(),
    issue: jest.fn(async () => "code_1"),
  };
  const usage = { recordWalletLogin: jest.fn(async () => undefined) };
  const service = new WalletAuthService(
    prisma as unknown as PrismaService,
    security as unknown as SecurityEventService,
    claim as unknown as ClaimService,
    sso as unknown as SsoService,
    usage as unknown as UsageService,
  );
  return { prisma, security, claim, sso, usage, service };
}

beforeEach(() => verifyMock.mockReset());

describe("challenge", () => {
  it("rejects a malformed address", async () => {
    const { service } = setup();
    await expect(
      service.challenge({ namespace: "solana", reference: "mainnet-beta", address: "bad!" }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("binds the message to address, chain, action and origin", async () => {
    const { prisma, service } = setup();
    const view = await service.challenge(
      { namespace: "solana", reference: "mainnet-beta", address: "SoLanaAddress" },
      { origin: "https://app.example" },
    );
    expect(view.message).toContain("SoLanaAddress");
    // SIWS layout Phantom validates: page host as domain.
    expect(view.message.split("\n")[0]).toBe("app.example wants you to sign in with your Solana account:");
    // No Chain ID line: Phantom refuses a value that differs from its own network.
    expect(view.message).not.toContain("Chain ID:");
    expect(view.message).toContain("URI: https://app.example");
    // SIWS statement grammar is ASCII-only; a typographic dash breaks Phantom's parser.
    expect(view.message).toMatch(/^[\x20-\x7e\n]+$/);
    expect(prisma.walletAuthChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "login", address: "SoLanaAddress" }) }),
    );
  });

  it("uses the EIP-4361 fields for EVM (word Ethereum, numeric chain id)", async () => {
    const { service } = setup();
    const view = await service.challenge(
      { namespace: "evm", reference: "1", address: "0x0000000000000000000000000000000000000001" },
      { origin: "http://localhost:3302" },
    );
    expect(view.message.split("\n")[0]).toBe("localhost:3302 wants you to sign in with your Ethereum account:");
    expect(view.message).toContain("Chain ID: 1");
    expect(view.message).toContain("URI: http://localhost:3302");
  });

  it("refuses an unallowlisted returnTo", async () => {
    const { sso, service } = setup();
    sso.resolveReturnTo.mockResolvedValue(null as never);
    await expect(
      service.challenge(
        { namespace: "solana", reference: "mainnet-beta", address: "SoLanaAddress", returnTo: "https://evil.example" },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a link challenge without a session", async () => {
    const { service } = setup();
    await expect(
      service.challenge({ namespace: "evm", reference: "1", address: "0xabc", action: "link" }, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("verifyLogin", () => {
  it("rejects an expired challenge without checking the signature", async () => {
    const { prisma, service } = setup();
    prisma.walletAuthChallenge.findUnique.mockResolvedValue(
      challengeRow({ expiresAt: new Date(Date.now() - 1000) }) as any,
    );
    await expect(service.verifyLogin("ch-1", "sig")).rejects.toBeInstanceOf(BadRequestException);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("rejects a bad signature and never consumes the challenge", async () => {
    const { prisma, service } = setup();
    verifyMock.mockResolvedValue(false);
    await expect(service.verifyLogin("ch-1", "sig")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.walletAuthChallenge.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when a concurrent verify already consumed the challenge", async () => {
    const { prisma, service } = setup();
    verifyMock.mockResolvedValue(true);
    prisma.walletAuthChallenge.updateMany.mockResolvedValue({ count: 0 } as any);
    await expect(service.verifyLogin("ch-1", "sig")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("mints a claim ticket for an unknown address — no identity is created", async () => {
    const { claim, service } = setup();
    verifyMock.mockResolvedValue(true);
    await expect(service.verifyLogin("ch-1", "sig")).resolves.toEqual({ kind: "claim", ticketId: "ct_1" });
    expect(claim.mintCredential).toHaveBeenCalledWith(
      { provider: "solana", providerUserId: "SoLanaAddress", email: null },
      undefined,
      undefined,
    );
  });

  it("returns the owning pid for a known address and rejects a suspended identity", async () => {
    const { prisma, service } = setup();
    verifyMock.mockResolvedValue(true);
    prisma.identityCredential.findUnique.mockResolvedValue({
      id: "cred-1",
      pid: "ifal@pid",
      identity: { status: "active" },
    } as any);
    await expect(service.verifyLogin("ch-1", "sig")).resolves.toEqual({
      kind: "session",
      pid: "ifal@pid",
      pidCode: undefined,
    });

    prisma.identityCredential.findUnique.mockResolvedValue({
      id: "cred-1",
      pid: "ifal@pid",
      identity: { status: "suspended" },
    } as any);
    await expect(service.verifyLogin("ch-1", "sig")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a link challenge on the login path", async () => {
    const { prisma, service } = setup();
    prisma.walletAuthChallenge.findUnique.mockResolvedValue(challengeRow({ action: "link", pid: "ifal@pid" }) as any);
    await expect(service.verifyLogin("ch-1", "sig")).rejects.toBeInstanceOf(BadRequestException);
  });
});

it("meters only app-bound logins (no clientId, no usage event)", async () => {
  const { prisma, usage, service } = setup();
  verifyMock.mockResolvedValue(true);
  prisma.identityCredential.findUnique.mockResolvedValue({
    id: "cred-1",
    pid: "ifal@pid",
    identity: { status: "active" },
  } as any);
  await service.verifyLogin("ch-1", "sig");
  expect(usage.recordWalletLogin).not.toHaveBeenCalled();

  const bound = setup();  verifyMock.mockResolvedValue(true);
  bound.prisma.walletAuthChallenge.findUnique.mockResolvedValue(
    challengeRow({ redirectTo: "https://app.example", clientId: "pidapp_x" }) as any,
  );
  bound.prisma.identityCredential.findUnique.mockResolvedValue({
    id: "cred-1",
    pid: "ifal@pid",
    identity: { status: "active" },
  } as any);
  await bound.service.verifyLogin("ch-1", "sig");
  expect(bound.usage.recordWalletLogin).toHaveBeenCalledWith("pidapp_x", "ifal@pid");
});

it("mints the SSO code for the app bound at challenge time", async () => {
  const { prisma, sso, service } = setup();
  verifyMock.mockResolvedValue(true);
  prisma.walletAuthChallenge.findUnique.mockResolvedValue(
    challengeRow({ redirectTo: "https://app.example", clientId: "pidapp_x", providerCode: "phantom", codeChallenge: "c".repeat(43) }) as any,
  );
  prisma.identityCredential.findUnique.mockResolvedValue({
    id: "cred-1",
    pid: "ifal@pid",
    identity: { status: "active" },
  } as any);
  await expect(service.verifyLogin("ch-1", "sig")).resolves.toEqual({
    kind: "session",
    pid: "ifal@pid",
    pidCode: "code_1",
  });
  expect(sso.issue).toHaveBeenCalledWith("ifal@pid", "https://app.example", {
    clientId: "pidapp_x",
    method: "phantom",
    codeChallenge: "c".repeat(43),
  });
});

describe("link", () => {
  it("refuses a challenge issued for another identity", async () => {
    const { prisma, service } = setup();
    verifyMock.mockResolvedValue(true);
    prisma.walletAuthChallenge.findUnique.mockResolvedValue(
      challengeRow({ action: "link", pid: "other@pid" }) as any,
    );
    await expect(service.link("ch-1", "sig", "ifal@pid")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("maps a unique-constraint race to 409 instead of reassigning", async () => {
    const { prisma, service } = setup();
    verifyMock.mockResolvedValue(true);
    prisma.walletAuthChallenge.findUnique.mockResolvedValue(
      challengeRow({ action: "link", pid: "ifal@pid" }) as any,
    );
    prisma.identityCredential.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }),
    );
    await expect(service.link("ch-1", "sig", "ifal@pid")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("unlink", () => {
  it("refuses to remove the last login method", async () => {
    const { prisma, service } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      id: "cred-1",
      pid: "ifal@pid",
      provider: "solana",
      providerUserId: "SoLanaAddress",
    } as any);
    prisma.identityCredential.count.mockResolvedValue(1 as any);
    await expect(service.unlink("ifal@pid", "cred-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("unlinks another identity's credential as not found", async () => {
    const { prisma, service } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      id: "cred-1",
      pid: "other@pid",
      provider: "solana",
      providerUserId: "SoLanaAddress",
    } as any);
    await expect(service.unlink("ifal@pid", "cred-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
