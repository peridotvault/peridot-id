import { decodeState, encodeState, isLoopbackReturnTo, SsoService } from "./sso.service";
import { PidAppsService } from "./apps.service";

function setup(apps?: { findActive: (clientId: string) => Promise<Record<string, unknown> | null> }) {
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
      create: jest.fn(
        async ({ data }: { data: { code: string; identityId: string; redirectTo: string; clientId?: string | null; expiresAt: Date } }) => {
          rows.set(data.code, { id: data.code, clientId: null, ...data, consumedAt: null });
          return rows.get(data.code);
        },
      ),
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
  const pidApps = apps ?? {
    findActive: jest.fn(async () => ({ redirectUris: ["https://mygame.dev/callback"] })),
  };
  const service = new SsoService(prisma as never, config as never, security as never, pidApps as never);
  return { service, rows, security };
}

const DEV_APP = { redirectUris: ["https://mygame.dev/callback"] };

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

  it("round-trips returnTo (+ clientId) through the opaque Google state", () => {
    expect(decodeState(encodeState("https://live2dev.com"))).toEqual({ returnTo: "https://live2dev.com" });
    const withApp = encodeState("https://mygame.dev/callback", "pidapp_abc");
    expect(decodeState(withApp)).toEqual({ returnTo: "https://mygame.dev/callback", clientId: "pidapp_abc" });
    // legacy plain returnTo states keep working
    expect(decodeState("https://live2dev.com")).toEqual({ returnTo: "https://live2dev.com" });
  });

  it("resolveReturnTo enforces an app's registered redirect URIs", async () => {
    const { service } = setup({ findActive: async (id) => (id === "pidapp_abc" ? DEV_APP : null) });
    await expect(service.resolveReturnTo("https://mygame.dev/callback", "pidapp_abc")).resolves.toEqual({
      redirectTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
    });
    await expect(service.resolveReturnTo("https://evil.com/steal", "pidapp_abc")).resolves.toBeNull();
    await expect(service.resolveReturnTo("https://mygame.dev/callback", "pidapp_nope")).resolves.toBeNull();
  });

  it("resolveReturnTo falls back to the global allowlist without a clientId", async () => {
    const { service } = setup();
    await expect(service.resolveReturnTo("https://live2dev.com")).resolves.toEqual({
      redirectTo: "https://live2dev.com",
    });
    await expect(service.resolveReturnTo("https://evil.com")).resolves.toBeNull();
    await expect(service.resolveReturnTo(undefined)).resolves.toBeNull();
  });

  it("loopback return targets are always allowed (any port/path, ± clientId)", async () => {
    const { service } = setup({ findActive: async () => null });
    await expect(service.resolveReturnTo("http://localhost:3000")).resolves.toEqual({
      redirectTo: "http://localhost:3000",
      clientId: undefined,
    });
    await expect(service.resolveReturnTo("http://localhost:8081/auth/callback?x=1")).resolves.toMatchObject({
      redirectTo: "http://localhost:8081/auth/callback?x=1",
    });
    await expect(service.resolveReturnTo("http://127.0.0.1:4000/")).resolves.toMatchObject({
      redirectTo: "http://127.0.0.1:4000/",
    });
    // clientId recorded but no registry lookup needed on loopback
    await expect(service.resolveReturnTo("http://localhost:3000", "pidapp_unregistered")).resolves.toEqual({
      redirectTo: "http://localhost:3000",
      clientId: "pidapp_unregistered",
    });
  });

  it("isLoopbackReturnTo rejects lookalikes and non-http schemes", () => {
    expect(isLoopbackReturnTo("http://localhost:3000/x")).toBe(true);
    expect(isLoopbackReturnTo("https://127.0.0.1:8443/")).toBe(true);
    expect(isLoopbackReturnTo("http://[::1]:3000/")).toBe(true);
    expect(isLoopbackReturnTo("https://localhost.evil.com/")).toBe(false);
    expect(isLoopbackReturnTo("https://evillocalhost:3000/")).toBe(false);
    expect(isLoopbackReturnTo("ftp://localhost/x")).toBe(false);
    expect(isLoopbackReturnTo("not a url")).toBe(false);
  });

  it("binds issued codes to the app: exchange requires the same client_id", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code, "pidapp_abc")).resolves.toMatchObject({ identityId: "pid_1" });

    const code2 = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code2, "pidapp_other")).rejects.toThrow("sso_code_invalid");
    await expect(service.consume(code2)).rejects.toThrow("sso_code_invalid");
  });

  it("requires the app secret at exchange when one is set (uniform error)", async () => {
    const secret = "pidsk_testsecret000000000000000000000000000001";
    const withSecret = {
      ...DEV_APP,
      clientSecretHash: PidAppsService.hashSecret(secret),
    };
    const { service } = setup({ findActive: async () => withSecret });
    const code = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code, "pidapp_abc", secret)).resolves.toMatchObject({ identityId: "pid_1" });

    const code2 = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code2, "pidapp_abc", "wrong-secret")).rejects.toThrow("sso_code_invalid");
    // failed attempts don't consume the code — missing secret also rejected, same error
    await expect(service.consume(code2, "pidapp_abc")).rejects.toThrow("sso_code_invalid");
  });
});
