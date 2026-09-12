import { ChainRegistryService } from "./chain-registry.service";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPL = "0x0000000000000000000000000000000000000001";

function setup(rows: unknown[], env: Record<string, string> = {}) {
  const prisma = { chain: { findMany: jest.fn(async () => rows) } };
  const config = {
    get: jest.fn((key: string) => env[key]),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in env)) throw new Error(`missing ${key}`);
      return env[key];
    }),
  };
  return new ChainRegistryService(prisma as never, config as never);
}

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "chain-1",
    namespace: "eip155",
    reference: "97",
    name: "bsc-testnet",
    nativeSymbol: "tBNB",
    decimals: 18,
    rpcUrls: ["https://bsc-testnet.example"],
    explorerUrl: null,
    logoUrl: null,
    isTestnet: true,
    contracts: [{ type: "factory", address: FACTORY, versionLabel: "v1" }],
    ...overrides,
  };
}

describe("ChainRegistryService", () => {
  it("returns DB rows with contracts when present", async () => {
    const service = setup([dbRow()]);
    const chains = await service.activeChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].contracts).toEqual([{ type: "factory", address: FACTORY, versionLabel: "v1" }]);
    expect(await service.rpcUrlForReference("97")).toBe("https://bsc-testnet.example");
  });

  it("falls back to code + env when the registry is empty", async () => {
    const service = setup([], { EVM_FACTORY_ADDRESS: FACTORY, EVM_IMPLEMENTATION_ADDRESS: IMPL });
    const chains = await service.activeChains();
    expect(chains.map((c) => c.reference).sort()).toEqual(["10143", "421614", "84532", "97"]);
    expect(await service.deploymentFor("97")).toEqual({ factory: FACTORY, implementation: IMPL });
  });

  it("enables no EVM chain when the factory is missing or invalid", async () => {
    const missing = setup([]);
    expect(await missing.deployableEvmChains()).toEqual([]);
    const garbage = setup([], { EVM_FACTORY_ADDRESS: "not-an-address", EVM_IMPLEMENTATION_ADDRESS: IMPL });
    expect(await garbage.deployableEvmChains()).toEqual([]);
    expect(await garbage.deploymentFor("97")).toBeNull();
  });

  it("requires both factory and implementation per chain", async () => {
    const service = setup([dbRow()]); // factory only
    expect(await service.deployableEvmChains()).toEqual([]);
  });

  it("caches reads and drops the cache on invalidate", async () => {
    const findMany = jest.fn(async () => [dbRow()]);
    const service = new ChainRegistryService(
      { chain: { findMany } } as never,
      { get: jest.fn(), getOrThrow: jest.fn(() => { throw new Error("missing"); }) } as never,
    );
    await service.activeChains();
    await service.activeChains();
    expect(findMany).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.activeChains();
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
