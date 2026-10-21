import { JwtStrategy } from "./jwt.strategy";
import { JWT_AUD_APP, JWT_AUD_REFRESH, JWT_AUD_SESSION, JWT_AUD_SSO, JWT_ISSUER } from "../common/app-config";
import { AccessTokenPayload } from "./auth.service";

function setup(status: string | null = "active") {
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const values: Record<string, unknown> = {
        JWT_ACCESS_SECRET: "strategy-test-secret",
        WALLET_URL: "http://localhost:3302",
      };
      return values[key] ?? def;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === "JWT_ACCESS_SECRET") return "strategy-test-secret";
      throw new Error(`Missing config: ${key}`);
    }),
  };
  const prisma = {
    identity: { findUnique: jest.fn(async () => (status ? { status } : null)) },
  };
  return { strategy: new JwtStrategy(config as never, prisma as never) };
}

function payload(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: "ifal@pid", type: "access", iss: JWT_ISSUER, aud: JWT_AUD_SESSION, ...overrides };
}

describe("JwtStrategy claim enforcement (ANT-227 item 1)", () => {
  for (const aud of [JWT_AUD_SESSION, JWT_AUD_APP, JWT_AUD_SSO]) {
    it(`accepts a live identity on the ${aud} audience`, async () => {
      const { strategy } = setup();
      await expect(strategy.validate(payload({ aud }))).resolves.toMatchObject({ pid: "ifal@pid" });
    });
  }

  it("rejects the refresh audience on the access strategy", async () => {
    const { strategy } = setup();
    await expect(strategy.validate(payload({ aud: JWT_AUD_REFRESH }))).rejects.toThrow("audience");
  });

  it("rejects a foreign issuer", async () => {
    const { strategy } = setup();
    await expect(strategy.validate(payload({ iss: "evil-id" }))).rejects.toThrow("issuer");
  });

  it("rejects non-access token types", async () => {
    const { strategy } = setup();
    await expect(strategy.validate({ ...payload(), type: "refresh" } as never)).rejects.toThrow("token type");
  });

  it("rejects suspended or missing identities", async () => {
    await expect(setup("suspended").strategy.validate(payload())).rejects.toThrow("not active");
    await expect(setup(null).strategy.validate(payload())).rejects.toThrow("not active");
  });
});
