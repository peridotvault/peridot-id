import { UnauthorizedException } from "@nestjs/common";
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

function redisMock() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, val: string) => {
      store.set(key, val);
      return "OK";
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
  };
}

function prismaMock() {
  const sessions = new Map<string, { deviceId: string; revokedAt: Date | null }>();
  return {
    device: {
      create: jest.fn(async (args: { data: { identityId: string; userAgent: string | null } }) => ({
        id: "device-1",
        ...args.data,
      })),
      update: jest.fn(async () => ({})),
    },
    session: {
      create: jest.fn(async (args: { data: { id: string; deviceId: string } }) => {
        sessions.set(args.data.id, { deviceId: args.data.deviceId, revokedAt: null });
        return args.data;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { revokedAt: Date } }) => {
        const s = sessions.get(where.id);
        if (s) s.revokedAt = data.revokedAt;
        return { count: s ? 1 : 0 };
      }),
    },
  };
}

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function setup() {
  const prisma = prismaMock() as unknown as never;
  const redis = redisMock();
  const jwt = new JwtService({});
  const config = configMock();
  const service = new AuthService(prisma, redis as never, jwt, config as never);
  return { service, prisma, redis, config, res: resMock() };
}

describe("AuthService", () => {
  it("issueSession stores a refresh token and sets both cookies", async () => {
    const { service, redis, res } = setup();
    const tokens = await service.issueSession(res as never, "identity-1", "test-agent");

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^rt:/), "identity-1", "EX", expect.any(Number));
    expect(res.cookie).toHaveBeenCalledTimes(2);
  });

  it("rotateSession revokes the old token and issues a new one", async () => {
    const { service, redis, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;
    expect(redis.store.get(`rt:${oldJti}`)).toBe("identity-1");

    await service.rotateSession(
      { cookies: { peridot_refresh: first.refreshToken }, headers: { "user-agent": "test-agent" } } as never,
      res as never,
    );

    expect(redis.store.get(`rt:${oldJti}`)).toBeUndefined();
    const remaining = [...redis.store.entries()].filter(([k]) => k.startsWith("rt:"));
    expect(remaining).toHaveLength(1);
  });

  it("rejects a reused (already rotated) refresh token", async () => {
    const { service, redis, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    await service.rotateSession(
      { cookies: { peridot_refresh: first.refreshToken }, headers: { "user-agent": "test-agent" } } as never,
      res as never,
    );

    await expect(
      service.rotateSession(
        { cookies: { peridot_refresh: first.refreshToken }, headers: { "user-agent": "test-agent" } } as never,
        res as never,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a forged refresh token", async () => {
    const { service, redis, res } = setup();
    const jwt = new JwtService({});
    const forged = await jwt.signAsync(
      { sub: "victim", jti: "does-not-exist", type: "refresh" },
      { secret: "refresh-secret-test", expiresIn: "30d" },
    );

    await expect(
      service.rotateSession(
        { cookies: { peridot_refresh: forged }, headers: {} } as never,
        res as never,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });
});

function jwtPayload(token: string): RefreshTokenPayload {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as RefreshTokenPayload;
}
