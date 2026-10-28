import { CODE_TTL_MS, decodeState, encodeState, isLoopbackReturnTo, pkceS256Challenge, pkceVerifyS256, SsoCodeInvalidError, SsoService } from "./sso.service";
import { PidAppsService } from "./apps.service";
import { mockSecurity } from "../../test/factories";


function setup(apps?: {
  findActive: (clientId: string) => Promise<Record<string, unknown> | null>;
  clientSecretValid?: (app: never, secret: string) => boolean;
}) {
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const values: Record<string, unknown> = {
        CLIENT_REDIRECT_ALLOWLIST: "https://live2dev.com, https://peridot.id",
      };
      return values[key] ?? def;
    }),
    getOrThrow: jest.fn((key: string) => (key === "JWT_ACCESS_SECRET" ? "test-secret" : key)),
  };
  const jwt = { signAsync: jest.fn(async () => "sso.jwt.token") };
  const security = mockSecurity();
  const rows = new Map<string, Record<string, unknown>>();
  const grants = new Map<string, Record<string, unknown>>();
  const grantKey = (pid: string, origin: string) => `${pid}|${origin}`;
  const prisma = {
    ssoCode: {
      create: jest.fn(
        async ({ data }: { data: { code: string; pid: string; redirectTo: string; clientId?: string | null; expiresAt: Date } }) => {
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
    ssoGrant: {
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { pid_origin: { pid: string; origin: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = grantKey(where.pid_origin.pid, where.pid_origin.origin);
          const existing = grants.get(key);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = {
            id: `grant_${grants.size + 1}`,
            firstSeenAt: new Date(),
            lastUsedAt: new Date(),
            revokedAt: null,
            clientId: null,
            ...create,
          };
          grants.set(key, row);
          return row;
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { pid_origin: { pid: string; origin: string } } }) =>
          grants.get(grantKey(where.pid_origin.pid, where.pid_origin.origin)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { pid: string; revokedAt: null } }) =>
        [...grants.values()]
          .filter((g) => g.pid === where.pid && (where.revokedAt === null ? g.revokedAt === null : true))
          .sort((a, b) => (b.lastUsedAt as Date).getTime() - (a.lastUsedAt as Date).getTime()),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; pid: string }; data: Record<string, unknown> }) => {
          let count = 0;
          for (const g of grants.values()) {
            if (g.id === where.id && g.pid === where.pid) {
              Object.assign(g, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
  };
  const pidApps = {
    findActive: jest.fn(async () => ({ redirectUris: ["https://mygame.dev/callback"] })),
    // Default mock: public client (no secret set) — always valid.
    clientSecretValid: jest.fn(() => true),
    ...apps,
  };
  const service = new SsoService(prisma as never, config as never, security as never, pidApps as never, jwt as never);
  return { service, rows, security };
}

const DEV_APP = { allowedOrigins: ["https://mygame.dev"] };

describe("SsoService", () => {
  it("only allows configured origins in the returnTo allowlist", () => {
    const { service } = setup();
    expect(service.isAllowedReturnTo("https://live2dev.com/auth/callback")).toBe(true);
    expect(service.isAllowedReturnTo("https://peridot.id/")).toBe(true);
    expect(service.isAllowedReturnTo("https://evil.com")).toBe(false);
    expect(service.isAllowedReturnTo("javascript:alert(1)")).toBe(false);
    expect(service.isAllowedReturnTo(undefined)).toBe(false);
  });

  it("always allows the first-party service URLs (ANT-193: no per-env maintenance)", () => {
    const { service } = setup();
    expect(service.allowlist()).toEqual(
      expect.arrayContaining(["http://localhost:3300", "http://localhost:3302", "https://live2dev.com"]),
    );
    expect(service.isAllowedReturnTo("http://localhost:3302/welcome")).toBe(true);
  });

  it("issues a single-use code and consumes it into an identity payload", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const identity = await service.consume(code, "https://live2dev.com/auth/callback");
    expect(identity.pid).toBe("pid_1");
    expect(identity.profile.displayName).toBe("Peridot");
    expect(identity.credentials[0].email).toBe("a@b.com");
    // RP backends need an app-scoped bearer for read APIs; TTL is seconds.
    expect(identity.accessToken).toBe("sso.jwt.token");
    expect(identity.expiresIn).toBeGreaterThan(0);
  });

  it("mints the exchange bearer with issuer + sso audience and a 24h TTL", async () => {
    const { service } = setup();
    const jwt = (service as unknown as { jwt: { signAsync: jest.Mock } }).jwt;
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    const identity = await service.consume(code, "https://live2dev.com/auth/callback");
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "pid_1", type: "access", scope: "read" }),
      expect.objectContaining({ issuer: "peridot-id", audience: "pid-sso" }),
    );
    // 24h cliff (ANT-227 item 7: was 30d).
    expect(identity.expiresIn).toBe(24 * 60 * 60);
  });

  it("rejects reusing the same code (single-use)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code, "https://live2dev.com/auth/callback");
    await expect(service.consume(code, "https://live2dev.com/auth/callback")).rejects.toThrow("sso_code_invalid");
  });

  // ANT-368: pid_code TTL is <=60s; code valid immediately, rejected after
  // expiry, replay still rejected (single-use intact).
  it("enforces a <=60s TTL: valid at issue, rejected after expiry, replay rejected", async () => {
    expect(CODE_TTL_MS).toBeLessThanOrEqual(60 * 1000);
    const { service, rows } = setup();
    const before = Date.now();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    const after = Date.now();
    // (a) expiry lands within TTL of issue time, and the fresh code exchanges.
    const stored = rows.get(code) as unknown as { expiresAt: Date };
    expect(stored.expiresAt.getTime()).toBeGreaterThan(before);
    // Bound against `after`, not `before`: expiresAt is stamped inside issue(),
    // so `expiresAt - before` includes issue() execution time and flakes by 1ms
    // on loaded runners. `expiresAt <= after + TTL` holds by construction.
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 1000);
    await expect(service.consume(code, "https://live2dev.com/auth/callback")).resolves.toMatchObject({ pid: "pid_1" });
    // (c) replay of the consumed code is rejected.
    await expect(service.consume(code, "https://live2dev.com/auth/callback")).rejects.toThrow("sso_code_invalid");
    // (b) an un-consumed code past its expiry is rejected.
    const code2 = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    (rows.get(code2) as unknown as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    await expect(service.consume(code2, "https://live2dev.com/auth/callback")).rejects.toThrow("sso_code_invalid");
  });

  it("rejects an unknown or expired code", async () => {
    const { service } = setup();
    await expect(service.consume("missing-code-000000000000", "https://live2dev.com/auth/callback")).rejects.toThrow("sso_code_invalid");
  });

  it("round-trips returnTo (+ clientId) through the opaque Google state", () => {
    expect(decodeState(encodeState("https://live2dev.com"))).toEqual({ returnTo: "https://live2dev.com" });
    const withApp = encodeState("https://mygame.dev/callback", "pidapp_abc");
    expect(decodeState(withApp)).toEqual({ returnTo: "https://mygame.dev/callback", clientId: "pidapp_abc" });
    // M5: the PKCE challenge rides the same envelope for public-client logins.
    const withPkce = encodeState("https://mygame.dev/callback", "pidapp_abc", CHALLENGE);
    expect(decodeState(withPkce)).toEqual({
      returnTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    // legacy plain returnTo states keep working
    expect(decodeState("https://live2dev.com")).toEqual({ returnTo: "https://live2dev.com" });
  });

  it("resolveReturnTo accepts any path on the app's allowed origins", async () => {
    const { service } = setup({ findActive: async (id) => (id === "pidapp_abc" ? DEV_APP : null) });
    await expect(service.resolveReturnTo("https://mygame.dev/callback", "pidapp_abc")).resolves.toEqual({
      redirectTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
    });
    // exact return URL passed in code — any path on the origin works
    await expect(service.resolveReturnTo("https://mygame.dev/other/path?x=1", "pidapp_abc")).resolves.toEqual({
      redirectTo: "https://mygame.dev/other/path?x=1",
      clientId: "pidapp_abc",
    });
    await expect(service.resolveReturnTo("https://evil.com/steal", "pidapp_abc")).resolves.toBeNull();
    await expect(service.resolveReturnTo("https://mygame.dev.evil.com/", "pidapp_abc")).resolves.toBeNull();
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
    const { service } = setup({ findActive: async (id) => (id === "pidapp_known" ? DEV_APP : null) });
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
    // Known clientId recorded, no origin-registry check needed on loopback.
    await expect(service.resolveReturnTo("http://localhost:3000", "pidapp_known")).resolves.toEqual({
      redirectTo: "http://localhost:3000",
      clientId: "pidapp_known",
    });
    // ANT-284: unknown clientIds are rejected even on loopback — a code bound
    // to them could never be exchanged, so minting it only creates confusion.
    await expect(service.resolveReturnTo("http://localhost:3000", "pidapp_unregistered")).resolves.toBeNull();
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
    const code = await service.issue("pid_1", "https://mygame.dev/callback", {
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", undefined, VERIFIER)).resolves.toMatchObject({
      pid: "pid_1",
    });

    const code2 = await service.issue("pid_1", "https://mygame.dev/callback", {
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    await expect(service.consume(code2, "https://mygame.dev/callback", "pidapp_other", undefined, VERIFIER)).rejects.toThrow(
      "sso_code_invalid",
    );
    await expect(service.consume(code2, "https://mygame.dev/callback", undefined, undefined, VERIFIER)).rejects.toThrow(
      "sso_code_invalid",
    );
  });

  it("records an app grant when a code is exchanged", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code, "https://live2dev.com/auth/callback");
    await expect(service.listGrants("pid_1")).resolves.toMatchObject([
      { origin: "https://live2dev.com", clientId: null, name: null },
    ]);
    await expect(service.isRevoked("pid_1", "https://live2dev.com/auth/callback")).resolves.toBe(false);
  });

  it("revoking hides the grant and flags the origin (authorize stays blocked)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code, "https://live2dev.com/auth/callback");
    const [grant] = await service.listGrants("pid_1");
    await service.revokeGrant("pid_1", grant.id as string);
    await expect(service.listGrants("pid_1")).resolves.toEqual([]);
    await expect(service.isRevoked("pid_1", "https://live2dev.com/other/path")).resolves.toBe(true);
    // unknown origins are not revoked
    await expect(service.isRevoked("pid_1", "https://evil.com/")).resolves.toBe(false);
  });

  it("revoke is identity-scoped and idempotent", async () => {
    const { service } = setup();
    const code = await service.issue("pid_2", "https://live2dev.com/auth/callback");
    await service.consume(code, "https://live2dev.com/auth/callback");
    const [grant] = await service.listGrants("pid_2");
    // another identity's revoke call touches nothing and never throws
    await service.revokeGrant("pid_1", grant.id as string);
    await expect(service.listGrants("pid_2")).resolves.toHaveLength(1);
    await service.revokeGrant("pid_2", "grant_missing");
    await expect(service.listGrants("pid_2")).resolves.toHaveLength(1);
  });

  it("a fresh full login heals a revoked grant (explicit re-consent)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code, "https://live2dev.com/auth/callback");
    const [grant] = await service.listGrants("pid_1");
    await service.revokeGrant("pid_1", grant.id as string);
    const code2 = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    await service.consume(code2, "https://live2dev.com/auth/callback");
    await expect(service.listGrants("pid_1")).resolves.toHaveLength(1);
    await expect(service.isRevoked("pid_1", "https://live2dev.com/")).resolves.toBe(false);
  });

  it("records the clientId and resolves the app name", async () => {
    const { service } = setup({
      findActive: async (id) => (id === "pidapp_abc" ? { ...DEV_APP, name: "My Game" } : null),
    });
    const code = await service.issue("pid_1", "https://mygame.dev/callback", {
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    await service.consume(code, "https://mygame.dev/callback", "pidapp_abc", undefined, VERIFIER);
    await expect(service.listGrants("pid_1")).resolves.toMatchObject([
      { origin: "https://mygame.dev", clientId: "pidapp_abc", name: "My Game" },
    ]);
  });

  it("requires the app secret at exchange when one is set (uniform error)", async () => {
    const secret = "pidsk_testsecret000000000000000000000000000001";
    const withSecret = {
      ...DEV_APP,
      clientSecretHash: PidAppsService.hashSecret(secret),
      clientSecretValid: (app: { clientSecretHash: string }, s: string) =>
        PidAppsService.secretMatches(s, app.clientSecretHash),
    };
    const { service } = setup({ findActive: async () => withSecret, clientSecretValid: withSecret.clientSecretValid });
    const code = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", secret)).resolves.toMatchObject({ pid: "pid_1" });

    const code2 = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code2, "https://mygame.dev/callback", "pidapp_abc", "wrong-secret")).rejects.toThrow("sso_code_invalid");
    // failed attempts don't consume the code — missing secret also rejected, same error
    await expect(service.consume(code2, "https://mygame.dev/callback", "pidapp_abc")).rejects.toThrow("sso_code_invalid");
  });

  it("requires the exact redirect_uri the code was issued for (M1)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    // Wrong redirect target: same uniform error, no oracle.
    await expect(service.consume(code, "https://evil.com/auth/callback")).rejects.toThrow("sso_code_invalid");
    // Missing redirect target: same uniform error.
    await expect(service.consume(code, "")).rejects.toThrow("sso_code_invalid");
    // Exact match still exchanges.
    await expect(service.consume(code, "https://live2dev.com/auth/callback")).resolves.toMatchObject({ pid: "pid_1" });
  });

  it("rejects redirect_uri drift even on app-bound codes (M1)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "https://mygame.dev/callback", {
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    // Right client, wrong path on the same origin: still rejected (exact match, not origin match).
    await expect(service.consume(code, "https://mygame.dev/other", "pidapp_abc", undefined, VERIFIER)).rejects.toThrow(
      "sso_code_invalid",
    );
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", undefined, VERIFIER)).resolves.toMatchObject(
      {
        pid: "pid_1",
      },
    );
  });

  it("rejects an expired app secret at exchange (uniform error, code unconsumed)", async () => {
    const expired = {
      ...DEV_APP,
      clientSecretHash: "abcdef",
      clientSecretExpiresAt: new Date(Date.now() - 1000),
      clientSecretValid: () => false,
    };
    const { service } = setup({ findActive: async () => expired, clientSecretValid: expired.clientSecretValid });
    const code = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", "any-secret")).rejects.toThrow("sso_code_invalid");
    // Failed attempts don't consume the code.
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", "any-secret")).rejects.toThrow("sso_code_invalid");
  });

  // PKCE S256 for public clients (ANT-284).
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const CHALLENGE = pkceS256Challenge(VERIFIER);

  it("pkceS256Challenge matches the RFC 7636 appendix-B vector", () => {
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("exchanges a challenged code only with its verifier (uniform error otherwise)", async () => {
    const { service } = setup();
    const code = await service.issue("pid_1", "http://localhost:3000/cb", { codeChallenge: CHALLENGE });
    // Missing verifier: same uniform error, no oracle.
    await expect(service.consume(code, "http://localhost:3000/cb")).rejects.toThrow("sso_code_invalid");
    // Wrong verifier: same uniform error.
    await expect(service.consume(code, "http://localhost:3000/cb", undefined, undefined, `${VERIFIER}XX`)).rejects.toThrow(
      "sso_code_invalid",
    );
    // Verifier on an unchallenged code: rejected too (confusion guard).
    const plain = await service.issue("pid_1", "http://localhost:3000/cb");
    await expect(service.consume(plain, "http://localhost:3000/cb", undefined, undefined, VERIFIER)).rejects.toThrow(
      "sso_code_invalid",
    );
    // Correct verifier exchanges.
    await expect(service.consume(code, "http://localhost:3000/cb", undefined, undefined, VERIFIER)).resolves.toMatchObject({
      pid: "pid_1",
    });
  });

  it("rejects non-S256 methods and malformed challenges at issue time", async () => {
    const { service } = setup();
    await expect(service.issue("pid_1", "http://localhost:3000/cb", { codeChallenge: "whatever", codeChallengeMethod: "plain" })).rejects.toThrow(
      "sso_pkce_invalid",
    );
    await expect(service.issue("pid_1", "http://localhost:3000/cb", { codeChallenge: "too-short" })).rejects.toThrow(
      "sso_pkce_invalid",
    );
    await expect(service.issue("pid_1", "http://localhost:3000/cb", { codeChallengeMethod: "S256" })).rejects.toThrow(
      "sso_pkce_invalid",
    );
    expect(pkceVerifyS256("short", CHALLENGE)).toBe(false);
  });

  // M5 (ANT-802): PKCE is mandatory for public clients (no backend secret).
  it("refuses to mint a public-client code without an S256 challenge (M5)", async () => {
    const { service } = setup(); // default mock app has no secret → public
    await expect(service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" })).rejects.toThrow(
      "sso_pkce_invalid",
    );
  });

  it("still mints confidential-client codes without a challenge (secret at exchange instead)", async () => {
    const withSecret = {
      ...DEV_APP,
      clientSecretHash: "abcdef",
      clientSecretValid: () => true,
    };
    const { service } = setup({ findActive: async () => withSecret, clientSecretValid: withSecret.clientSecretValid });
    const code = await service.issue("pid_1", "https://mygame.dev/callback", { clientId: "pidapp_abc" });
    await expect(service.consume(code, "https://mygame.dev/callback", "pidapp_abc", "any-secret")).resolves.toMatchObject({
      pid: "pid_1",
    });
  });

  it("never exchanges a pre-enforcement public-client code (minted challengeless, M5)", async () => {
    const { service, rows } = setup();
    // Stage a code as minted before enforcement: public app binding, no challenge.
    rows.set("legacy-public-code-000000000000", {
      id: "legacy-public-code-000000000000",
      code: "legacy-public-code-000000000000",
      pid: "pid_1",
      redirectTo: "https://mygame.dev/callback",
      clientId: "pidapp_abc",
      codeChallenge: null,
      codeChallengeMethod: null,
      expiresAt: new Date(Date.now() + 60 * 1000),
      consumedAt: null,
    });
    // No verifier presented either: the code falls through the PKCE checks
    // (nothing to verify against) and must die at the public-client gate —
    // the secret check below is vacuous for secretless apps.
    await expect(
      service.consume("legacy-public-code-000000000000", "https://mygame.dev/callback", "pidapp_abc"),
    ).rejects.toThrow("sso_code_invalid");
  });

  // ANT-693: every exchange rejection carries a machine-readable reason for
  // the server log while the public message stays uniform (no oracle).
  it("tags exchange failures with a machine reason (public message stays uniform)", async () => {
    const { service } = setup();
    const take = async (p: Promise<unknown>): Promise<SsoCodeInvalidError> => {
      try {
        await p;
      } catch (e) {
        return e as SsoCodeInvalidError;
      }
      throw new Error("expected exchange to fail");
    };

    // Unknown code.
    const unknown = await take(service.consume("missing-code-000000000000", "https://live2dev.com/auth/callback"));
    expect(unknown).toBeInstanceOf(SsoCodeInvalidError);
    expect(unknown.message).toBe("sso_code_invalid");
    expect(unknown.reason).toBe("unknown_or_consumed");

    // Redirect drift on a live code.
    const code = await service.issue("pid_1", "https://live2dev.com/auth/callback");
    expect((await take(service.consume(code, "https://evil.com/auth/callback"))).reason).toBe("redirect_mismatch");

    // Successful exchange, then replay of the consumed code.
    await service.consume(code, "https://live2dev.com/auth/callback");
    expect((await take(service.consume(code, "https://live2dev.com/auth/callback"))).reason).toBe("unknown_or_consumed");

    // Client mismatch on an app-bound code (verifier supplied so the
    // failure asserted is the binding, not PKCE — PKCE runs first).
    const appCode = await service.issue("pid_1", "https://mygame.dev/callback", {
      clientId: "pidapp_abc",
      codeChallenge: CHALLENGE,
    });
    expect((await take(service.consume(appCode, "https://mygame.dev/callback", "pidapp_other", undefined, VERIFIER))).reason).toBe(
      "client_mismatch",
    );
  });
});
