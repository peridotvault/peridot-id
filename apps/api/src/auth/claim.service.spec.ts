import { BadRequestException, ConflictException, GoneException } from "@nestjs/common";
import { ClaimService } from "./claim.service";

const PROFILE = { id: "google-1", displayName: "New User", emails: [{ value: "new@example.com" }], photos: [{ value: "http://pic" }] };

function setup() {
  const prisma: Record<string, any> = {
    claimTicket: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "ct_x", ...args.data })),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    identity: {
      create: jest.fn(async (args: { data: { pid: string } }) => ({ ...args.data, status: "active" })),
      findUnique: jest.fn(async () => null),
    },
    profile: { create: jest.fn(async (args: { data: unknown }) => args.data) },
    identityCredential: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (args: { data: unknown }) => args.data),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const security = { log: jest.fn(async () => undefined) };
  const config = { get: (_k: string, d?: string) => d ?? "" };
  const service = new ClaimService(prisma as never, security as never, config as never);
  return { service, prisma, security, config };
}

function liveTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: "ct_x",
    provider: "google",
    providerUserId: "google-1",
    email: "new@example.com",
    displayName: "New User",
    avatarUrl: "http://pic",
    redirectTo: null,
    clientId: null,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("ClaimService", () => {
  it("mints a ticket from a verified Google profile", async () => {
    const { service, prisma } = setup();
    const id = await service.mint(PROFILE);

    expect(id).toMatch(/^ct_/);
    expect(prisma.claimTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "google", providerUserId: "google-1", email: "new@example.com" }),
      }),
    );
  });

  it("reports status for a live ticket, null otherwise", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket());

    await expect(service.status("ct_x")).resolves.toMatchObject({ email: "new@example.com", displayName: "New User" });
    await expect(service.status(undefined)).resolves.toBeNull();

    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket({ consumedAt: new Date() }));
    await expect(service.status("ct_x")).resolves.toBeNull();

    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(service.status("ct_x")).resolves.toBeNull();
  });

  it("claims a fresh PID in one transaction and consumes the ticket", async () => {
    const { service, prisma, security } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket());

    const res = await service.claim("ct_x", "IFAL");

    expect(res).toMatchObject({ pid: "ifal@pid", redirectTo: null });
    expect(prisma.identity.create).toHaveBeenCalledWith({ data: { pid: "ifal@pid", status: "active", role: "user" } });
    expect(prisma.claimTicket.update).toHaveBeenCalledWith({ where: { id: "ct_x" }, data: { consumedAt: expect.any(Date) } });
    // Audit must join the claim transaction: the root client cannot see the
    // uncommitted identity row (P2003 + full rollback — see issue log).
    expect(security.log).toHaveBeenCalledWith("ifal@pid", "identity.claimed", { provider: "google" }, prisma);
  });

  it("grants admin to a bootstrap PID from env", async () => {
    const { service, prisma, config } = setup();
    config.get = (_k: string, d?: string) => (_k === "PID_BOOTSTRAP_ADMIN_PID" ? "ifal@pid, ops@pid" : (d ?? ""));
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket());
    await service.claim("ct_x", "IFAL");
    expect(prisma.identity.create).toHaveBeenCalledWith({ data: { pid: "ifal@pid", status: "active", role: "admin" } });
  });

  it("rejects an invalid handle", async () => {
    const { service, prisma } = setup();
    await expect(service.claim("ct_x", "ab")).rejects.toThrow(BadRequestException);
    expect(prisma.identity.create).not.toHaveBeenCalled();
  });

  it("rejects a taken PID", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket());
    prisma.identity.findUnique.mockResolvedValue({ pid: "ifal@pid" });

    await expect(service.claim("ct_x", "ifal")).rejects.toThrow(ConflictException);
    await expect(service.claim("ct_x", "ifal")).rejects.toThrow("PID already taken");
  });

  it("rejects consumed or expired tickets with 410", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket({ consumedAt: new Date() }));
    await expect(service.claim("ct_x", "ifal")).rejects.toThrow(GoneException);

    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(service.claim("ct_x", "ifal")).rejects.toThrow("sign in again");
  });

  it("rejects an already-linked credential or email", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(liveTicket());
    prisma.identityCredential.findUnique.mockResolvedValue({ id: "cred" });
    await expect(service.claim("ct_x", "ifal")).rejects.toThrow("already linked");

    prisma.identityCredential.findUnique.mockResolvedValue(null);
    prisma.identityCredential.findFirst.mockResolvedValue({ id: "cred-other" });
    await expect(service.claim("ct_x", "ifal")).rejects.toThrow("Email is already linked");
  });

  it("carries the SSO targets through to the caller", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.findUnique.mockResolvedValue(
      liveTicket({ redirectTo: "https://live2dev.com/auth/callback", clientId: "pidapp_abc" }),
    );

    const res = await service.claim("ct_x", "ifal");
    expect(res).toMatchObject({ pid: "ifal@pid", redirectTo: "https://live2dev.com/auth/callback", clientId: "pidapp_abc" });
  });

  it("abandon consumes a live ticket and ignores the rest", async () => {
    const { service, prisma } = setup();
    prisma.claimTicket.updateMany = jest.fn(async () => ({ count: 1 }));

    await expect(service.abandon("ct_x")).resolves.toBeUndefined();
    expect(prisma.claimTicket.updateMany).toHaveBeenCalledWith({
      where: { id: "ct_x", consumedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { consumedAt: expect.any(Date) },
    });

    await expect(service.abandon(undefined)).resolves.toBeUndefined();
  });
});
