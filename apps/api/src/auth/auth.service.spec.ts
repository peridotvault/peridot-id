import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService, RefreshTokenPayload } from "./auth.service";

function configMock(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: "access-secret-test",
    JWT_REFRESH_SECRET: "refresh-secret-test",
    ACCESS_TOKEN_TTL: "15m",
    REFRESH_TOKEN_TTL: "30d",
    COOKIE_SECURE: "false",
    COOKIE_DOMAIN: "localhost",
    COOKIE_SAMESITE: "lax",
    ...overrides,
  };
  return {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`Missing config: ${key}`);
      return values[key];
    }),
  };
}

interface StoredSession {
  deviceId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

function prismaMock() {
  const sessions = new Map<string, StoredSession>();
    const mocks: Record<string, unknown> = {
      identityCredential: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async (args: { data: { lastLoginAt: Date } }) => args.data),
        create: jest.fn(async (args: { data: unknown }) => args.data),
      },
      identity: {
        create: jest.fn(async (args: { data: { id: string; status: string } }) => args.data),
      },
      profile: {
        create: jest.fn(async (args: { data: unknown }) => args.data),
        findUnique: jest.fn(async () => null),
      },
      device: {
        create: jest.fn(async (args: { data: { identityId: string; userAgent: string | null } }) => ({
          id: "device-1",
          ...args.data,
        })),
        update: jest.fn(async () => ({})),
      },
      session: {
        create: jest.fn(
          async (args: { data: { id: string; deviceId: string; expiresAt: Date; rotatedFrom: string | null } }) => {
            sessions.set(args.data.id, {
              deviceId: args.data.deviceId,
              revokedAt: null,
              expiresAt: args.data.expiresAt,
            });
            return args.data;
          },
        ),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: { revokedAt: Date } }) => {
          const s = sessions.get(where.id);
          if (s) s.revokedAt = data.revokedAt;
          return s ?? null;
        }),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { revokedAt: Date } }) => {
          const s = sessions.get(where.id);
          if (s) s.revokedAt = data.revokedAt;
          return { count: s ? 1 : 0 };
        }),
      },
    };
    mocks.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(mocks));
    return mocks as any;
  }

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function setup() {
  const prisma = prismaMock();
  const jwt = new JwtService({});
  const config = configMock();
  const service = new AuthService(prisma as never, jwt, config as never);
  return { service, prisma, config, res: resMock() };
}

function reqWithToken(token: string) {
  return { cookies: { peridot_refresh: token }, headers: { "user-agent": "test-agent" } } as never;
}

describe("AuthService", () => {
  it("signup creates identity with pid_ ULID, profile and credential", async () => {
    const { service, prisma } = setup();
    const identity = await service.upsertGoogleIdentity({ id: "google-1", displayName: "Ranaufal Muha" });

    expect(identity.id).toMatch(/^pid_[0-9A-HJKMNP-TV-Z]+$/);
    expect(prisma.identity.create).toHaveBeenCalledWith({ data: { id: identity.id, status: "active" } });
    expect(prisma.profile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ username: "ranaufal" }) }),
    );
    expect(prisma.identityCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provider: "google", providerUserId: "google-1" }),
    });
  });

  it("login with existing credential reuses the identity and bumps lastLoginAt", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      identity: { id: "pid_01HASH", status: "active" },
    });

    const identity = await service.upsertGoogleIdentity({ id: "google-1", displayName: "Ranaufal" });

    expect(identity.id).toBe("pid_01HASH");
    expect(prisma.identityCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
    );
    expect(prisma.identity.create).not.toHaveBeenCalled();
  });

  it("rejects a new Google credential whose email belongs to another PID", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findFirst.mockResolvedValue({ id: "cred-other" });

    const promise = service.upsertGoogleIdentity({
      id: "google-new",
      displayName: "Ranaufal",
      emails: [{ value: "taken@example.com" }],
    });
    await expect(promise).rejects.toThrow(ConflictException);
    await expect(promise).rejects.toThrow("Email sudah terhubung dengan akun lain");
    expect(prisma.identity.create).not.toHaveBeenCalled();
    expect(prisma.identityCredential.create).not.toHaveBeenCalled();
  });

  it("returns the existing identity without an email-collision check on returning login", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      identity: { id: "pid_01HASH", status: "active" },
    });

    await service.upsertGoogleIdentity({ id: "google-1", displayName: "Ranaufal", emails: [{ value: "mine@example.com" }] });

    expect(prisma.identityCredential.findFirst).not.toHaveBeenCalled();
  });

  it("skips the email-collision check when the Google profile has no email", async () => {
    const { service, prisma } = setup();

    await service.upsertGoogleIdentity({ id: "google-2", displayName: "Ranaufal" });

    expect(prisma.identityCredential.findFirst).not.toHaveBeenCalled();
    expect(prisma.identityCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provider: "google", providerUserId: "google-2", email: null }),
    });
  });

  it("signup with a free email stores the email and skips rejection", async () => {
    const { service, prisma } = setup();

    const identity = await service.upsertGoogleIdentity({
      id: "google-3",
      displayName: "Ranaufal",
      emails: [{ value: "free@example.com" }],
    });

    expect(identity.id).toMatch(/^pid_[0-9A-HJKMNP-TV-Z]+$/);
    expect(prisma.identityCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "free@example.com" }),
    });
  });

  it("issueSession creates a session row and sets both cookies", async () => {
    const { service, prisma, res } = setup();
    const tokens = await service.issueSession(res as never, "identity-1", "test-agent");

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(prisma.session.create).toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledTimes(2);
  });

  it("rotateSession revokes the old token and issues a new one", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;

    await service.rotateSession(reqWithToken(first.refreshToken), res as never);

    const old = (await prisma.session.findUnique({ where: { id: oldJti } })) as StoredSession;
    expect(old.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects a reused (already rotated) refresh token", async () => {
    const { service, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    await service.rotateSession(reqWithToken(first.refreshToken), res as never);

    await expect(service.rotateSession(reqWithToken(first.refreshToken), res as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects a forged refresh token", async () => {
    const { service, res } = setup();
    const jwt = new JwtService({});
    const forged = await jwt.signAsync(
      { sub: "victim", jti: "does-not-exist", type: "refresh" },
      { secret: "refresh-secret-test", expiresIn: "30d" },
    );

    await expect(service.rotateSession(reqWithToken(forged), res as never)).rejects.toThrow(UnauthorizedException);
  });
});

function jwtPayload(token: string): RefreshTokenPayload {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as RefreshTokenPayload;
}
