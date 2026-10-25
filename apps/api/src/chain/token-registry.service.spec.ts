// Token registry reads: visible-only, chain-scoped, inactive-chain hiding,
// logo URL building.
import { TokenRegistryService } from "./token-registry.service";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    mint: "M",
    decimals: 6,
    isVisible: true,
    isPinned: false,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    token: { symbol: "TST", name: "Test", logoKey: "public/tokens/TST.png" },
    chain: { namespace: "solana", reference: "devnet", isActive: true },
    ...over,
  };
}

function setup(rows: ReturnType<typeof row>[] = [row()]) {
  const prisma = { tokenDeployment: { findMany: jest.fn(async () => rows) } };
  const config = { get: (k: string) => (k === "API_URL" ? "https://api.example" : "") };
  return { service: new TokenRegistryService(prisma as never, config as never), prisma };
}

describe("TokenRegistryService", () => {
  it("returns visible deployments with proxy logo URLs", async () => {
    const { service } = setup();
    const tokens = await service.visibleTokens("solana", "devnet");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ symbol: "TST", logoUrl: "https://api.example/v1/tokens/logo?key=public%2Ftokens%2FTST.png" });
  });

  it("hides deployments of inactive chains", async () => {
    const { service } = setup([row({ chain: { namespace: "solana", reference: "devnet", isActive: false } })]);
    expect(await service.visibleTokens()).toEqual([]);
  });

  it("scopes by chain and fails open to []", async () => {
    const { service } = setup();
    expect(await service.visibleTokens("eip155", "97")).toEqual([]);
    const broken = new TokenRegistryService({ tokenDeployment: { findMany: jest.fn(async () => { throw new Error("down"); }) } } as never);
    expect(await broken.visibleTokens()).toEqual([]);
  });

  it("nulls logoUrl when the API origin is unconfigured", async () => {
    const prisma = { tokenDeployment: { findMany: jest.fn(async () => [row()]) } };
    const service = new TokenRegistryService(prisma as never, { get: () => "" } as never);
    const [t] = await service.visibleTokens();
    expect(t.logoUrl).toBeNull();
  });

  it("caches reads and drops the cache on invalidate", async () => {
    const { service, prisma } = setup();
    await service.visibleTokens();
    await service.visibleTokens();
    expect(prisma.tokenDeployment.findMany).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.visibleTokens();
    expect(prisma.tokenDeployment.findMany).toHaveBeenCalledTimes(2);
  });
});
