import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { accountRefreshCookieName } from "../common/cookies";
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

interface StoredDevice {
  id: string;
  createdAt: Date;
  authMethod: string | null;
}

interface StoredSession {
  deviceId: string;
  rotatedFrom: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  expiresAt: Date;
}

function prismaMock() {
  const sessions = new Map<string, StoredSession>();
  const devices = new Map<string, StoredDevice>();
    const mocks: Record<string, unknown> = {
      identityCredential: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async (args: { data: { lastLoginAt: Date } }) => args.data),
        create: jest.fn(async (args: { data: unknown }) => args.data),
      },
      identity: {
        create: jest.fn(async (args: { data: { pid: string; status: string } }) => args.data),
        findUnique: jest.fn(async () => null),
      },
      profile: {
        create: jest.fn(async (args: { data: unknown }) => args.data),
        findUnique: jest.fn(async () => null),
      },
      device: {
        create: jest.fn(async (args: { data: { pid: string; userAgent: string | null; authMethod?: string | null } }) => {
          const device = { id: `device-${devices.size + 1}`, createdAt: new Date(), authMethod: args.data.authMethod ?? null };
          devices.set(device.id, device);
          return { ...device, ...args.data };
        }),
        update: jest.fn(async () => ({})),
      },
      session: {
        create: jest.fn(
          async (args: { data: { id: string; deviceId: string; expiresAt: Date; rotatedFrom: string | null } }) => {
            sessions.set(args.data.id, {
              deviceId: args.data.deviceId,
              rotatedFrom: args.data.rotatedFrom ?? null,
              createdAt: new Date(),
              revokedAt: null,
              expiresAt: args.data.expiresAt,
            });
            return args.data;
          },
        ),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const s = sessions.get(where.id);
          if (!s) return null;
          // live device reference: tests backdate createdAt to simulate family age
          const device = devices.get(s.deviceId) ?? { id: s.deviceId, createdAt: new Date(), authMethod: null };
          return { ...s, device };
        }),
        // Live stored reference (not a copy): tests backdate createdAt to
        // simulate a child born outside the rotation grace window.
        findFirst: jest.fn(
          async ({
            where,
          }: {
            where: { rotatedFrom?: string; revokedAt?: null; expiresAt?: { gt: Date }; createdAt?: { gt: Date } };
          }) => {
            for (const [id, s] of sessions.entries()) {
              if (where.rotatedFrom !== undefined && s.rotatedFrom !== where.rotatedFrom) continue;
              if (where.revokedAt === null && s.revokedAt !== null) continue;
              if (where.expiresAt && !(s.expiresAt > where.expiresAt.gt)) continue;
              if (where.createdAt && !(s.createdAt > where.createdAt.gt)) continue;
              const device = devices.get(s.deviceId) ?? { id: s.deviceId, createdAt: new Date(), authMethod: null };
              return Object.assign(s, { id, device });
            }
            return null;
          },
        ),
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
        findMany: jest.fn(async ({ where }: { where: { device: { pid: string } } }) =>
          [...sessions.entries()]
            .filter(([, s]) => s.revokedAt === null && s.expiresAt > new Date())
            .map(([id, s]) => ({
              id,
              deviceId: s.deviceId,
              revokedAt: s.revokedAt,
              expiresAt: s.expiresAt,
              createdAt: new Date(),
              device: {
                id: s.deviceId,
                pid: where.device.pid,
                userAgent: "test-agent",
                lastSeenAt: new Date(),
                createdAt: new Date(),
              },
            })),
        ),
      },
    };
    mocks.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(mocks));
    return mocks as any;
  }

function resMock() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function setup(overrides: Record<string, unknown> = {}) {
  const prisma = prismaMock();
  const jwt = new JwtService({});
  const config = configMock(overrides);
  const service = new AuthService(prisma as never, jwt, config as never);
  return { service, prisma, config, res: resMock() };
}

function reqWithToken(token: string) {
  return { cookies: { pid_refresh: token }, headers: { "user-agent": "test-agent" } } as never;
}

describe("AuthService", () => {
  it("findGoogleIdentity returns null for an unknown credential (claim flow takes over)", async () => {
    const { service, prisma } = setup();

    await expect(service.findGoogleIdentity("google-new")).resolves.toBeNull();
    expect(prisma.identity.create).not.toHaveBeenCalled();
    expect(prisma.identityCredential.create).not.toHaveBeenCalled();
  });

  it("reports PID availability", async () => {
    const { service, prisma } = setup();
    await expect(service.isPidAvailable("ifal")).resolves.toEqual({ available: true, pid: "ifal@pid" });
    (prisma.identity.findUnique as jest.Mock).mockResolvedValue({ pid: "ifal@pid" });
    await expect(service.isPidAvailable("ifal")).resolves.toEqual({ available: false, pid: null });
    await expect(service.isPidAvailable("ab")).resolves.toEqual({ available: false, pid: null });
  });

  it("login with existing credential reuses the identity and bumps lastLoginAt", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      identity: { pid: "ifal@pid", status: "active" },
    });

    const identity = await service.findGoogleIdentity("google-1");

    expect(identity).toMatchObject({ pid: "ifal@pid" });
    expect(prisma.identityCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
    );
    expect(prisma.identity.create).not.toHaveBeenCalled();
  });

  it("returns the existing identity without an email-collision check on returning login", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findUnique.mockResolvedValue({
      identity: { pid: "ifal@pid", status: "active" },
    });

    await service.findGoogleIdentity("google-1");

    expect(prisma.identityCredential.findFirst).not.toHaveBeenCalled();
  });

  it("issueSession creates a session row and sets the active + per-identity cookies", async () => {
    const { service, prisma, res } = setup();
    const tokens = await service.issueSession(res as never, "identity-1", "test-agent");

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(prisma.session.create).toHaveBeenCalled();
    const names = (res.cookie as jest.Mock).mock.calls.map(([n]) => n);
    expect(names).toEqual(["pid_access", "pid_refresh", accountRefreshCookieName("identity-1")]);
  });

  it("rotateSession revokes the old token and issues a new one", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;

    await service.rotateSession(reqWithToken(first.refreshToken), res as never);

    const old = (await prisma.session.findUnique({ where: { id: oldJti } })) as StoredSession;
    expect(old.revokedAt).toBeInstanceOf(Date);
  });

  it("reuses the rotation child on concurrent reuse inside the grace window", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;
    await service.rotateSession(reqWithToken(first.refreshToken), res as never);

    // Loser tab retries with the same superseded token: follows the child,
    // keeps a single live head (child revoked, grandchild live).
    await service.rotateSession(reqWithToken(first.refreshToken), res as never);
    const child = (await prisma.session.findFirst({ where: { rotatedFrom: oldJti } })) as StoredSession;
    expect(child.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects reuse past the rotation grace window", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;
    await service.rotateSession(reqWithToken(first.refreshToken), res as never);
    const child = (await prisma.session.findFirst({ where: { rotatedFrom: oldJti } })) as StoredSession;
    child.createdAt = new Date(Date.now() - 61 * 1000);

    const err = await service.rotateSession(reqWithToken(first.refreshToken), res as never).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(JSON.stringify(err.getResponse())).not.toContain("step_up_required");
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

  it("listSessions marks only the current refresh jti as current", async () => {
    const { service, res } = setup();
    const tokens = await service.issueSession(res as never, "identity-1", "test-agent");
    const currentJti = jwtPayload(tokens.refreshToken).jti;

    const sessions = await service.listSessions("identity-1", currentJti);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].isCurrent).toBe(true);
    expect(sessions[0].id).toBe(currentJti);
  });

  it("revokeOtherSessions keeps the current session and revokes the rest", async () => {
    const { service, prisma, res } = setup();
    const tokens = await service.issueSession(res as never, "identity-1", "test-agent");
    const currentJti = jwtPayload(tokens.refreshToken).jti;

    await service.revokeOtherSessions("identity-1", currentJti);

    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ device: { pid: "identity-1" }, id: { not: currentJti } }),
        data: { revokedAt: expect.any(Date) },
      }),
    );
  });

  it("currentSessionJti returns null for a bad token", async () => {
    const { service } = setup();
    expect(await service.currentSessionJti(undefined)).toBeNull();
    expect(await service.currentSessionJti("not-a-jwt")).toBeNull();
  });

  it("records the login method on the device", async () => {
    const { service, prisma, res } = setup();
    await service.issueSession(res as never, "identity-1", "test-agent", undefined, "passkey");
    expect(prisma.device.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ authMethod: "passkey" }) }),
    );
  });

  it("rejects rotation past the 90-day google family cap with step_up_required", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent", undefined, "google");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);

    const err = await service.rotateSession(reqWithToken(first.refreshToken), res as never).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ code: "step_up_required" });
  });

  it("lets google families rotate inside 90 days", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent", undefined, "google");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    await service.rotateSession(reqWithToken(first.refreshToken), res as never);
  });

  it("honors a GOOGLE_FAMILY_MAX_AGE override", async () => {
    const { service, prisma, res } = setup({ GOOGLE_FAMILY_MAX_AGE: "7d" });
    const first = await service.issueSession(res as never, "identity-1", "test-agent", undefined, "google");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    const err = await service.rotateSession(reqWithToken(first.refreshToken), res as never).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ code: "step_up_required" });
  });

  it("falls back to the default cap on unparseable env", async () => {
    const { service, prisma, res } = setup({ GOOGLE_FAMILY_MAX_AGE: "bogus" });
    const first = await service.issueSession(res as never, "identity-1", "test-agent", undefined, "google");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    await service.rotateSession(reqWithToken(first.refreshToken), res as never);
  });

  it("treats pre-existing (method-less) devices as google families", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);

    await expect(service.rotateSession(reqWithToken(first.refreshToken), res as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("lets passkey families rotate inside a year but not past 365 days", async () => {
    const { service, prisma, res } = setup();
    const first = await service.issueSession(res as never, "identity-1", "test-agent", undefined, "passkey");
    const oldJti = jwtPayload(first.refreshToken).jti;
    const stored = (await prisma.session.findUnique({ where: { id: oldJti } })) as unknown as {
      device: { createdAt: Date };
    };
    stored.device.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await service.rotateSession(reqWithToken(first.refreshToken), res as never);

    const refreshCalls = (res.cookie as jest.Mock).mock.calls.filter(([name]) => name === "pid_refresh");
    const fresh = refreshCalls[refreshCalls.length - 1][1] as string;
    stored.device.createdAt = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
    const err = await service.rotateSession(reqWithToken(fresh), res as never).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ code: "step_up_required" });
  });
});

function jwtPayload(token: string): RefreshTokenPayload {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as RefreshTokenPayload;
}

describe("AuthService account switcher", () => {
  const A = "ifal@pid";
  const B = "kupuakz@pid";

  it("issueSession records a per-identity refresh cookie", async () => {
    const { service, res } = setup();
    await service.issueSession(res as never, A, "ua");
    const names = (res.cookie as jest.Mock).mock.calls.map(([n]) => n);
    expect(names).toContain(accountRefreshCookieName(A));
  });

  it("lists linked identities with the active one first", async () => {
    const { service, res } = setup();
    const a = await service.issueSession(res as never, A, "ua");
    const b = await service.issueSession(res as never, B, "ua");
    const req = {
      cookies: {
        pid_refresh: b.refreshToken,
        [accountRefreshCookieName(A)]: a.refreshToken,
        [accountRefreshCookieName(B)]: b.refreshToken,
      },
    } as never;

    const accounts = await service.listAccounts(req);

    expect(accounts.map((x) => x.pid)).toEqual([B, A]);
    expect(accounts[0].isActive).toBe(true);
    expect(accounts[1].isActive).toBe(false);
  });

  it("switches the active cookies from the target identity's own refresh cookie", async () => {
    const { service, res } = setup();
    const a = await service.issueSession(res as never, A, "ua");
    const req = { cookies: { pid_refresh: a.refreshToken, [accountRefreshCookieName(A)]: a.refreshToken } } as never;

    await service.switchAccount(req, res as never, A);

    const activeRefresh = (res.cookie as jest.Mock).mock.calls.filter(([n]) => n === "pid_refresh").pop()[1];
    expect(activeRefresh).toBe(a.refreshToken);
  });

  it("rejects switching to an identity with no stored session", async () => {
    const { service, res } = setup();
    await expect(service.switchAccount({ cookies: {} } as never, res as never, "nobody@pid")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("signs out one identity and leaves the rest signed in", async () => {
    const { service, res } = setup();
    const a = await service.issueSession(res as never, A, "ua");
    const b = await service.issueSession(res as never, B, "ua");
    const req = {
      cookies: {
        pid_refresh: b.refreshToken,
        [accountRefreshCookieName(A)]: a.refreshToken,
        [accountRefreshCookieName(B)]: b.refreshToken,
      },
    } as never;

    await service.signOutAccount(req, res as never, A);

    (res.clearCookie as jest.Mock).mock.calls.forEach(([n]) => {
      if (typeof n === "string" && n.startsWith("pid_refresh__")) {
        expect(n).toBe(accountRefreshCookieName(A));
      }
    });
    const remaining = await service.listAccounts({
      cookies: { pid_refresh: b.refreshToken, [accountRefreshCookieName(B)]: b.refreshToken },
    } as never);
    expect(remaining.map((x) => x.pid)).toEqual([B]);
  });
});
