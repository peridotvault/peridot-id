import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { ProvidersController, loginPage } from "./providers.controller";
import { ProvidersService } from "./providers.service";

const KEY = "a".repeat(64);

function setup() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    loginProvider: { findUnique: jest.fn(async () => ({ protocol: "wallet_signature" })), create: jest.fn(async () => ({})) },
    credentialDomain: { create: jest.fn(async () => ({})) },
    chainFamily: { findUnique: jest.fn(async () => ({ code: "eip155" })) },
    chain: { count: jest.fn(async () => 1) },
    $executeRaw: jest.fn(),
    providerChainPolicy: { findUnique: jest.fn(async () => ({ id: "policy" })), upsert: jest.fn(async args => args) },
    providerChainSelection: { deleteMany: jest.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (fn: unknown) => (typeof fn === "function" ? (fn as (t: unknown) => unknown)(tx) : Promise.all(fn as Promise<unknown>[]))),
    loginProvider: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      create: tx.loginProvider.create,
      update: jest.fn(async () => ({})),
    },
    platformOAuthConfig: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    chainFamily: { findMany: jest.fn(async () => []), create: jest.fn(async ({ data }) => data) },
    loginEvent: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    credentialDomain: tx.credentialDomain,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const security: any = { log: jest.fn(async () => undefined) };
  const config = {
    get: jest.fn((key: string, def?: string) =>
      key === "PID_SECRETS_ENC_KEY" ? KEY : key === "API_URL" ? "https://api.peridot.id" : (def ?? "")),
  };
  return { tx, prisma, security, config, service: new ProvidersService(prisma as never, security as never, config as never) };
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    code: "phantom", name: "Phantom", imageUrl: null, category: "web3", protocol: "wallet_signature",
    isAvailable: true, chainPolicies: [], platformOauthConfig: null, ...overrides,
  };
}

describe("global provider availability gate", () => {
  it("rejects an unknown or globally disabled provider", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue(null);
    await expect(service.assertUsable("email")).rejects.toThrow("not available");
    prisma.loginProvider.findUnique.mockResolvedValue({ isAvailable: false });
    await expect(service.assertUsable("email")).rejects.toThrow("not available");
    prisma.loginProvider.findUnique.mockResolvedValue({ isAvailable: true });
    await expect(service.assertUsable("email")).resolves.toBeUndefined();
  });
});

describe("provider chain configuration", () => {
  it("rejects a selection from a different family before replacing existing rows", async () => {
    const { tx, service } = setup();
    tx.chain.count.mockResolvedValue(0);
    await expect(service.chains("admin@pid", "phantom", "eip155", "selected", ["solana-chain"])).rejects.toThrow("chosen family");
    expect(tx.providerChainSelection.deleteMany).not.toHaveBeenCalled();
  });
  it("rejects OAuth providers and mixed all/selected configuration", async () => {
    const { tx, service } = setup();
    tx.loginProvider.findUnique.mockResolvedValue({ protocol: "oauth" });
    await expect(service.chains("admin@pid", "google", "eip155", "selected", [])).rejects.toThrow("Wallet provider");
    await expect(service.chains("admin@pid", "phantom", "eip155", "all", ["chain"])).rejects.toThrow("All mode");
  });
  it("replaces selected membership atomically, deduplicating chain IDs", async () => {
    const { tx, service } = setup();
    await service.chains("admin@pid", "phantom", "eip155", "selected", ["chain", "chain"]);
    expect(tx.providerChainSelection.deleteMany).toHaveBeenCalledWith({ where: { policyId: "policy" } });
    expect(tx.providerChainPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { mode: "selected", selections: { create: [{ chainId: "chain" }] } },
    }));
  });
});

describe("provider catalogue admin", () => {
  it("creates a provider unavailable until an adapter and configuration are ready", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue(providerRow({ code: "custom", protocol: "wallet_signature", category: "web3" }));
    await service.create("admin@pid", { code: "custom", name: "Custom", category: "web3", protocol: "wallet_signature" });
    expect(prisma.loginProvider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: "custom", isAvailable: false }),
    });
  });

  it("creates the credential domain for an OAuth provider", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue(providerRow({ code: "custom", protocol: "oauth", category: "web2" }));
    await service.create("admin@pid", { code: "custom", name: "Custom", category: "web2", protocol: "oauth" });
    expect(prisma.credentialDomain.create).toHaveBeenCalledWith({ data: { code: "custom", providerCode: "custom" } });
  });

  it("accepts raster image URLs only and rejects SVG or foreign protocols", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue(providerRow({ code: "img1", protocol: "passkey", category: "web2" }));
    const base = { code: "img1", name: "Img", category: "web2" as const, protocol: "passkey" };
    await expect(service.create("admin@pid", { ...base, imageUrl: "https://cdn.example.com/icon.svg" }))
      .rejects.toThrow("image URL");
    await expect(service.create("admin@pid", { ...base, imageUrl: "javascript:alert(1)" }))
      .rejects.toThrow("image URL");
    await expect(service.create("admin@pid", { ...base, imageUrl: "https://cdn.example.com/icon.png" }))
      .resolves.toBeDefined();
  });

  it("rejects a Web3 provider that is not a wallet signature and vice versa", async () => {
    const { service } = setup();
    await expect(service.create("admin@pid", { code: "x1", name: "X", category: "web3", protocol: "oauth" })).rejects.toThrow("Web3");
    await expect(service.create("admin@pid", { code: "x2", name: "X", category: "web2", protocol: "wallet_signature" })).rejects.toThrow("Web3");
  });

  it("refuses to enable a provider with no implemented adapter", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "discord", protocol: "oauth", isAvailable: false, platformOauthConfig: null });
    await expect(service.update("admin@pid", "discord", { isAvailable: true })).rejects.toThrow("No runtime adapter");
  });

  it("refuses to enable an OAuth provider with incomplete configuration", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "google", protocol: "oauth", isAvailable: false, platformOauthConfig: null });
    await expect(service.update("admin@pid", "google", { isAvailable: true })).rejects.toThrow("incomplete");
  });

  it("enables an adapter-backed provider when configuration is complete", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue(providerRow({ isAvailable: false }));
    await service.update("admin@pid", "phantom", { isAvailable: true });
    expect(prisma.loginProvider.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isAvailable: true } }));
  });
});

describe("platform OAuth configuration", () => {
  it("stores the secret as an enc:v1 envelope and never returns it", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "google", protocol: "oauth", platformOauthConfig: { providerCode: "google" } });
    prisma.platformOAuthConfig.findUnique.mockResolvedValue(null);
    await service.setOauthConfig("admin@pid", "google", { clientId: "client", clientSecret: "super-secret" });
    const stored = prisma.platformOAuthConfig.upsert.mock.calls[0][0] as { create: { clientSecretEnc: string } };
    expect(stored.create.clientSecretEnc.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(await service.oauthConfig("google"))).not.toContain("super-secret");
  });

  it("requires a secret for a new configuration and refuses unsupported adapters", async () => {
    const { prisma, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "google", protocol: "oauth", platformOauthConfig: null });
    await expect(service.setOauthConfig("admin@pid", "google", { clientId: "client" })).rejects.toThrow("secret is required");
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "discord", protocol: "oauth", platformOauthConfig: null });
    await expect(service.setOauthConfig("admin@pid", "discord", { clientId: "client", clientSecret: "secret123" }))
      .rejects.toThrow("No OAuth adapter");
  });

  it("audits configuration changes without secret material", async () => {
    const { prisma, security, service } = setup();
    prisma.loginProvider.findUnique.mockResolvedValue({ code: "google", protocol: "oauth", platformOauthConfig: { providerCode: "google" } });
    prisma.platformOAuthConfig.findUnique.mockResolvedValue(null);
    await service.setOauthConfig("admin@pid", "google", { clientId: "client", clientSecret: "super-secret" });
    const metadata = security.log.mock.calls[0][2] as Record<string, unknown>;
    expect(metadata).toMatchObject({ providerCode: "google", secretRotated: true });
    expect(JSON.stringify(metadata)).not.toContain("super-secret");
  });
});

describe("admin authorization and login history", () => {
  const guards = (handler: unknown) => Reflect.getMetadata("__guards__", handler as object) as unknown[];

  it.each(["adminList", "detail", "create", "update", "oauth", "setOauth", "chains", "families", "createFamily", "adminLogins"])(
    "%s requires a logged-in admin (machine tokens rejected by AdminGuard)",
    method => {
      const applied = guards(ProvidersController.prototype[method as keyof ProvidersController]) ?? [];
      expect(applied).toContain(JwtAuthGuard);
      expect(applied).toContain(AdminGuard);
    },
  );

  it("checks app ownership before querying events", async () => {
    const providers = { logins: jest.fn() };
    const apps = { get: jest.fn(async () => { throw new Error("App not found"); }) };
    const controller = new ProvidersController(providers as never, apps as never);
    await expect(controller.appLogins({ pid: "other@pid" } as never, "app", "1")).rejects.toThrow("App not found");
    expect(providers.logins).not.toHaveBeenCalled();
  });

  it("filters admin history by app, PID, provider, evidence and time", async () => {
    const { prisma, service } = setup();
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2026-11-30T00:00:00Z");
    await service.logins(undefined, 1, {
      appId: "app-1", pid: "ifal@pid", providerCode: "google", evidence: "server", from, to,
    });
    const where = prisma.loginEvent.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      appId: "app-1", pid: "ifal@pid", providerCode: "google", providerEvidence: "server",
      occurredAt: { gte: from, lte: to },
    });
  });

  it.each(["0", "-1", "1.1", "100000", "x"])("rejects bad pagination %s", page => {
    expect(() => loginPage(page)).toThrow("Invalid page");
  });
});
