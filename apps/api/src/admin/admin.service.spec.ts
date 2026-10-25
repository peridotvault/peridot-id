import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { decryptSecret } from "../common/secret-crypto";
import { AdminService } from "./admin.service";
import { mockSecurity } from "../../test/factories";


const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// ANT-286a test data key (clearly labeled fixture — never a real secret).
const TEST_ENC_KEY = "ab".repeat(32);

function setup() {
  const prisma = {
    chain: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async (): Promise<any> => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "chain-1", ...args.data })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "chain-1", ...args.data })),
    },
    chainContract: {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => ({ id: "cc-1", ...args.create })),
    },
    evmRelayerKey: {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => ({ ...args.create, updatedAt: new Date(0) })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    token: {
      findMany: jest.fn(async (): Promise<any[]> => []),
      findUnique: jest.fn(async (): Promise<any> => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "tok-1", symbol: "TST", name: "Test", ...args.data })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "tok-1", ...args.data })),
    },
    tokenDeployment: {
      findUnique: jest.fn(async (): Promise<any> => null),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "dep-1", ...args.data })),
    },
    identity: { findUnique: jest.fn(async () => ({ role: "admin", status: "active" })) },
    pidApp: {
      findUnique: jest.fn(async (): Promise<any> => null),
      findMany: jest.fn(async (): Promise<any[]> => []),
      update: jest.fn(async (args: { where: { id: string }; data: { isVerified: boolean } }) => ({
        id: args.where.id, clientId: "pidapp_x", webhookSecret: "wh", clientSecretHash: "hash", ...args.data,
      })),
    },
  };
  const chains = { invalidate: jest.fn() };
  const tokenRegistry = { invalidate: jest.fn() };
  const wasabi = {
    putTokenLogo: jest.fn(async () => "public/tokens/TST.png"),
    moveLogo: jest.fn(async () => undefined),
  };
  const security = mockSecurity();
  const config = { get: (k: string, d?: string) => (k === "PID_SECRETS_ENC_KEY" ? TEST_ENC_KEY : (d ?? "")) };
  const service = new AdminService(prisma as never, chains as never, tokenRegistry as never, wasabi as never, security as never, config as never);
  const guard = new AdminGuard(prisma as never);
  return { service, prisma, chains, tokenRegistry, wasabi, security, guard };
}

const IDENTITY = "pid_admin";

describe("AdminService", () => {
  it("creates chains and logs the event", async () => {
    const { service, prisma, chains, security } = setup();
    const chain = await service.createChain(IDENTITY, {
      namespace: "eip155",
      reference: "84532",
      name: "base-sepolia",
      nativeSymbol: "ETH",
    });
    expect(chain.reference).toBe("84532");
    expect(chains.invalidate).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.chain.created", expect.anything());
    expect(prisma.chain.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decimals: 18 }) }),
    );
  });

  it("rejects duplicate chains", async () => {
    const { service, prisma } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-1" });
    await expect(
      service.createChain(IDENTITY, { namespace: "eip155", reference: "97", name: "x", nativeSymbol: "T" }),
    ).rejects.toThrow(ConflictException);
  });

  it("upserts contracts by type and rejects EVM types on Solana", async () => {
    const { service, prisma } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-1", namespace: "eip155" });
    const contract = await service.upsertContract(IDENTITY, "chain-1", { type: "factory", address: FACTORY });
    expect(contract.address).toBe(FACTORY);
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-sol", namespace: "solana" });
    await expect(service.upsertContract(IDENTITY, "chain-sol", { type: "factory", address: FACTORY })).rejects.toThrow(
      ConflictException,
    );
  });

  it("404s on unknown chains", async () => {
    const { service } = setup();
    await expect(service.updateChain(IDENTITY, "missing", { name: "x" })).rejects.toThrow(NotFoundException);
    await expect(service.upsertContract(IDENTITY, "missing", { type: "factory", address: FACTORY })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("verifies and unverifies apps with an audit event", async () => {
    const { service, prisma, security } = setup();
    prisma.pidApp.findUnique.mockResolvedValue({ id: "app-1", clientId: "pidapp_x" });

    const verified = await service.setAppVerified(IDENTITY, "app-1", true);
    expect(verified).toMatchObject({ id: "app-1", isVerified: true });
    expect(verified).not.toHaveProperty("webhookSecret");
    expect(verified).not.toHaveProperty("clientSecretHash");
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.app.verified", {
      appId: "app-1", clientId: "pidapp_x",
    });

    await service.setAppVerified(IDENTITY, "app-1", false);
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.app.unverified", {
      appId: "app-1", clientId: "pidapp_x",
    });
  });

  it("404s verify on unknown apps and never leaks secrets", async () => {
    const { service } = setup();
    await expect(service.setAppVerified(IDENTITY, "missing", true)).rejects.toThrow(NotFoundException);
  });

  it("lists every app without secrets", async () => {
    const { service, prisma } = setup();
    (prisma.pidApp.findMany as jest.Mock).mockResolvedValue([
      { id: "a1", clientId: "pidapp_1", name: "One", isVerified: true, webhookSecret: "w", clientSecretHash: "h" },
      { id: "a2", clientId: "pidapp_2", name: "Two", isVerified: false, webhookSecret: null, clientSecretHash: null },
    ]);
    const apps = await service.listAllApps();
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ id: "a1", isVerified: true });
    expect(apps[0]).not.toHaveProperty("webhookSecret");
    expect(prisma.pidApp.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" }, take: 500, skip: undefined });
  });

  it("searches apps by name or clientId substring", async () => {
    const { service, prisma } = setup();
    await service.listAllApps("live");
    expect(prisma.pidApp.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ name: { contains: "live", mode: "insensitive" } }, { clientId: { contains: "live" } }],
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      skip: undefined,
    });
    await service.listAllApps("   ");
    expect(prisma.pidApp.findMany).toHaveBeenLastCalledWith({ orderBy: { createdAt: "desc" }, take: 500, skip: undefined });
  });

  it("bounds pages: caps take, clamps negative skip (ANT-344 L5)", async () => {
    const { service, prisma } = setup();
    (prisma.pidApp.findMany as jest.Mock).mockResolvedValue([]);
    await service.listAllApps(undefined, 10, 20);
    expect(prisma.pidApp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 }),
    );
    await service.listAllApps(undefined, 10_000, -5);
    expect(prisma.pidApp.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 500, skip: undefined }),
    );
  });

  it("finds apps by clientId for admins without secrets", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({
      id: "app-1", clientId: "pidapp_x", name: "Live2Dev", isVerified: true,
      webhookSecret: "wh", clientSecretHash: "hash",
    });
    const app = await service.findAppByClientId("pidapp_x");
    expect(app).toMatchObject({ id: "app-1", isVerified: true });
    expect(app).not.toHaveProperty("webhookSecret");
    expect(app).not.toHaveProperty("clientSecretHash");
    await expect(service.findAppByClientId("pidapp_nope")).rejects.toThrow(NotFoundException);
  });

  it("guards the admin surface end to end (user denied, admin allowed)", async () => {
    const { guard, prisma } = setup();
    const ctx = (id?: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: id ? { pid: id } : undefined }) }) }) as never;
    prisma.identity.findUnique.mockResolvedValue({ role: "user", status: "active" });
    await expect(guard.canActivate(ctx("pid_user"))).rejects.toThrow(ForbiddenException);
    prisma.identity.findUnique.mockResolvedValue({ role: "admin", status: "active" });
    await expect(guard.canActivate(ctx(IDENTITY))).resolves.toBe(true);
  });

  it("sets the EVM relayer key write-only (envelope-encrypted at rest, event logged)", async () => {
    const { service, prisma, security } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-97", namespace: "eip155", reference: "97" });
    const secret = "0x" + "22".repeat(32);
    const res = await service.setEvmRelayer(IDENTITY, "chain-97", secret);
    const upsertArg = (prisma.evmRelayerKey.upsert as jest.Mock).mock.calls[0][0];
    const stored = upsertArg.create.secret as string;
    // ANT-286a: stored value is the enc:v1: envelope, never plaintext.
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, TEST_ENC_KEY)).toBe(secret);
    expect(upsertArg.update.secret).toBe(stored);
    expect(res).toEqual({ chainId: "chain-97", hasSecret: true, updatedAt: expect.any(Date) });
    expect(JSON.stringify(res)).not.toContain("22".repeat(8));
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.evm_relayer.set", { chainId: "chain-97" });
    expect(security.log).not.toHaveBeenCalledWith(IDENTITY, "admin.evm_relayer.set", expect.objectContaining({ secret }));
  });

  it("fails closed on setEvmRelayer without a usable data key (never stores plaintext)", async () => {
    const { prisma, chains, tokenRegistry, wasabi, security } = setup();
    const noKey = new AdminService(prisma as never, chains as never, tokenRegistry as never, wasabi as never, security as never, { get: () => "" } as never);
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-97", namespace: "eip155", reference: "97" });
    const secret = "0x" + "33".repeat(32);
    await expect(noKey.setEvmRelayer(IDENTITY, "chain-97", secret)).rejects.toThrow("PID_SECRETS_ENC_KEY");
    expect(prisma.evmRelayerKey.upsert).not.toHaveBeenCalled();
  });

  it("rejects the EVM relayer key for missing chains and non-EVM chains", async () => {
    const { service, prisma } = setup();
    prisma.chain.findUnique.mockResolvedValue(null);
    await expect(service.setEvmRelayer(IDENTITY, "nope", "0x" + "22".repeat(32))).rejects.toThrow(NotFoundException);
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-sol", namespace: "solana", reference: "devnet" });
    await expect(service.setEvmRelayer(IDENTITY, "chain-sol", "0x" + "22".repeat(32))).rejects.toThrow(ConflictException);
  });

  it("deletes the EVM relayer key and logs the event", async () => {
    const { service, prisma, security } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-97", namespace: "eip155", reference: "97" });
    await expect(service.deleteEvmRelayer(IDENTITY, "chain-97")).resolves.toEqual({ ok: true });
    expect(prisma.evmRelayerKey.deleteMany).toHaveBeenCalledWith({ where: { chainId: "chain-97" } });
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.evm_relayer.deleted", { chainId: "chain-97" });
  });

  it("creates tokens with deployments (EVM mints lowercased) in one save", async () => {
    const { service, prisma, tokenRegistry, security } = setup();
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-97", namespace: "eip155", reference: "97" });
    const token = await service.createToken(IDENTITY, {
      symbol: "tst",
      name: "Test Token",
      deployments: [
        { chainId: "chain-97", mint: "0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD", decimals: 18 },
      ],
    });
    expect(token.symbol).toBe("TST");
    const createArg = (prisma.token.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.deployments.create[0].mint).toBe("0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd");
    expect(tokenRegistry.invalidate).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.token.created", expect.objectContaining({ tokenId: "tok-1", symbol: "TST" }));
  });

  it("rejects duplicate symbols and unknown chains", async () => {
    const { service, prisma } = setup();
    prisma.token.findUnique.mockResolvedValueOnce({ id: "tok-1" });
    await expect(
      service.createToken(IDENTITY, { symbol: "USDC", name: "USD Coin", deployments: [] }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.token.create).not.toHaveBeenCalled();
    prisma.token.findUnique.mockResolvedValueOnce(null);
    prisma.chain.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.createToken(IDENTITY, {
        symbol: "NEW",
        name: "New",
        deployments: [{ chainId: "nope", mint: "M", decimals: 6 }],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects duplicate chains within one save", async () => {
    const { service, prisma } = setup();
    prisma.token.findUnique.mockResolvedValueOnce(null);
    prisma.chain.findUnique.mockResolvedValue({ id: "c1", namespace: "solana", reference: "devnet" });
    await expect(
      service.createToken(IDENTITY, {
        symbol: "DUP",
        name: "Dup",
        deployments: [
          { chainId: "c1", mint: "M", decimals: 6 },
          { chainId: "c1", mint: "M", decimals: 6 },
        ],
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.token.create).not.toHaveBeenCalled();
  });

  it("updates token metadata and deployment visibility/pin", async () => {
    const { service, prisma, tokenRegistry, security } = setup();
    prisma.token.findUnique.mockResolvedValue({ id: "tok-1" });
    await service.updateToken(IDENTITY, "tok-1", { name: "Renamed" });
    expect(prisma.token.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok-1" }, data: expect.objectContaining({ name: "Renamed" }) }),
    );
    expect(tokenRegistry.invalidate).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.token.updated", { tokenId: "tok-1" });
    prisma.token.findUnique.mockResolvedValue(null);
    await expect(service.updateToken(IDENTITY, "nope", { name: "x" })).rejects.toThrow(NotFoundException);

    prisma.tokenDeployment.findUnique.mockResolvedValue({ id: "dep-1" });
    await service.updateTokenDeployment(IDENTITY, "dep-1", { isVisible: false, isPinned: true });
    expect(prisma.tokenDeployment.update).toHaveBeenCalledWith({
      where: { id: "dep-1" },
      data: { isVisible: false, isPinned: true },
    });
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.token.deployment.updated", { deploymentId: "dep-1" });
  });

  it("uploads token logos to Wasabi by symbol", async () => {
    const { service, prisma, wasabi, tokenRegistry, security } = setup();
    prisma.token.findUnique.mockResolvedValue({ id: "tok-1", symbol: "TST" });
    const file = { buffer: Buffer.from("png"), mimetype: "image/png", size: 3, originalname: "l.png" };
    await service.setTokenLogo(IDENTITY, "tok-1", file);
    expect(wasabi.putTokenLogo).toHaveBeenCalledWith("TST", file);
    expect(prisma.token.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { logoKey: "public/tokens/TST.png" },
    });
    expect(tokenRegistry.invalidate).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.token.logo.updated", expect.anything());
  });

  it("maps logo keys to proxy URLs in the token list", async () => {
    const { prisma, chains, tokenRegistry, wasabi, security } = setup();
    const svc = new AdminService(
      prisma as never, chains as never, tokenRegistry as never, wasabi as never, security as never,
      { get: (k: string) => (k === "API_URL" ? "https://api.example" : "") } as never,
    );
    prisma.token.findMany.mockResolvedValue([
      { id: "tok-1", symbol: "TST", logoKey: "public/tokens/TST.png", deployments: [] },
      { id: "tok-2", symbol: "NON", logoKey: null, deployments: [] },
    ]);
    const rows = await svc.listTokens();
    expect(rows[0]).toMatchObject({ logoUrl: "https://api.example/v1/tokens/logo?key=public%2Ftokens%2FTST.png" });
    expect(rows[1]).toMatchObject({ logoUrl: null });
  });

  it("moves the logo object on symbol rename", async () => {
    const { service, prisma, wasabi, tokenRegistry } = setup();
    prisma.token.findUnique.mockResolvedValueOnce({ id: "tok-1", symbol: "OLD", logoKey: "public/tokens/OLD.png" });
    prisma.token.findUnique.mockResolvedValueOnce(null);
    await service.updateToken(IDENTITY, "tok-1", { symbol: "new" });
    expect(wasabi.moveLogo).toHaveBeenCalledWith("public/tokens/OLD.png", "public/tokens/NEW.png");
    expect(prisma.token.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ symbol: "NEW", logoKey: "public/tokens/NEW.png" }) }),
    );
    expect(tokenRegistry.invalidate).toHaveBeenCalled();
  });

  it("uploads chain logos and stores the proxy URL", async () => {
    const { prisma, chains, security } = setup();
    const wasabiChain = { putChainLogo: jest.fn(async () => "public/chains/eip155-97.png") };
    const svc = new AdminService(
      prisma as never, chains as never, { invalidate: jest.fn() } as never, wasabiChain as never, security as never,
      { get: (k: string) => (k === "API_URL" ? "https://api.example" : "") } as never,
    );
    prisma.chain.findUnique.mockResolvedValue({ id: "chain-97", namespace: "eip155", reference: "97" });
    const file = { buffer: Buffer.from("png"), mimetype: "image/png", size: 3, originalname: "l.png" };
    const updated = await svc.setChainLogo(IDENTITY, "chain-97", file);
    expect(wasabiChain.putChainLogo).toHaveBeenCalledWith("eip155", "97", file);
    expect(prisma.chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ logoUrl: "https://api.example/v1/tokens/logo?key=public%2Fchains%2Feip155-97.png" }) }),
    );
    expect(updated).toMatchObject({ logoUrl: "https://api.example/v1/tokens/logo?key=public%2Fchains%2Feip155-97.png" });
    expect(security.log).toHaveBeenCalledWith(IDENTITY, "admin.chain.logo.updated", expect.anything());
  });
});
