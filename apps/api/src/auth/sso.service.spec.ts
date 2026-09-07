import { SsoService } from "./sso.service";

function setup() {
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const values: Record<string, unknown> = {
        CLIENT_REDIRECT_ALLOWLIST: "https://live2dev.com, https://app.pid.peridotvault.com",
      };
      return values[key] ?? def;
    }),
  };
  const security = { log: jest.fn(async () => undefined) };
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    ssoCode: {
      create: jest.fn(async ({ data }: { data: { code: string; identityId: string; redirectTo: string; expiresAt: Date } }) => {
        rows.set(data.code, { id: data.code, ...data, consumedAt: null });
        return rows.get(data.code);
      }),
      findUnique: jest.fn(async ({ where }: { where: { code: string } }) => rows.get(where.code) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) => {
        const row = rows.get(where.id);
        if (row && !row.consumedAt) {
          row.consumedAt = data.consumedAt;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    profile: { findUnique: jest.fn(async () => ({ displayName: "Peridot", avatarUrl: null })) },
    identityCredential: { findMany: jest.fn(async () => [{ provider: "google", email: "a@b.com" }]) },
  };
  const service = new SsoService(prisma as never, config as never, security as never);
  return { service, rows, security };
}

describe("SsoService", () => {
  it("only allows configured origins in the returnTo allowlist", () => {
    const { service } = setup();
    expect(service.isAllowedReturnTo("https://live2dev.com/auth/callback")).toBe(true);
    expect(service.isAllowedReturnTo("https://app.pid.peridotvault.com/")).toBe(true);
    expect(service.isAllowedReturnTo("https://evil.com")).toBe(false);
    expect(service.isAllowedReturnTo("javascript:alert(1)")).toBe(false);
    expect(service.isAllowedReturnTo(undefined)).toBe(false);
  });

  it("issues a single-use code and consumes it into an identity payload", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const identity = await service.consume(code);
    expect(identity.identityId).toBe("pid_1");
    expect(identity.profile.displayName).toBe("Peridot");
    expect(identity.credentials[0].email).toBe("a@b.com");
  });

  it("rejects reusing the same code (single-use)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code);
    await expect(service.consume(code)).rejects.toThrow("sso_code_invalid");
  });

  it("rejects an unknown or expired code", async () => {
    const { service } = setup();
    await expect(service.consume("missing-code-000000000000")).rejects.toThrow("sso_code_invalid");
  });
});