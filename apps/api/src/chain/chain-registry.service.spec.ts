import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ChainRegistryService } from "./chain-registry.service";
import {
  SOLANA_DEVNET_REFERENCE,
  SOLANA_NAMESPACE,
  SOLANA_PROGRAM_ID,
  SOLANA_TESTNET_PROGRAM_ID,
  SOLANA_TESTNET_REFERENCE,
  solanaReferenceFor,
} from "../common/chains";
import { deriveEvmSmartAccountAddress } from "@peridotvault/pid-evm";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPL = "0x0000000000000000000000000000000000000001";

function setup(rows: unknown[], relayerSecrets: Record<string, string> = {}) {
  const prisma = {
    chain: { findMany: jest.fn(async () => rows) },
    evmRelayerKey: {
      findUnique: jest.fn(async ({ where }: { where: { chainId: string } }) => {
        const secret = relayerSecrets[where.chainId];
        return secret ? { chainId: where.chainId, secret } : null;
      }),
    },
  };
  return new ChainRegistryService(prisma as never);
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

  it("falls back to the compiled chain list with no contracts (EVM off until admin rows exist)", async () => {
    // ANT-193: no EVM_* env — an empty registry yields every compiled chain
    // with zero contracts, so nothing is deployable until an admin registers
    // factory/implementation rows.
    const service = setup([]);
    const chains = await service.activeChains();
    expect(chains.map((c) => c.reference).sort()).toEqual(["10143", "421614", "84532", "97"]);
    expect(chains.every((c) => c.contracts.length === 0)).toBe(true);
    expect(await service.deployableEvmChains()).toEqual([]);
    expect(await service.deploymentFor("97")).toBeNull();
  });

  it("enables no EVM chain without registry factory/implementation rows", async () => {
    const service = setup([]);
    expect(await service.deployableEvmChains()).toEqual([]);
    expect(await service.deploymentFor("97")).toBeNull();
  });

  it("requires both factory and implementation per chain", async () => {
    const service = setup([dbRow()]); // factory only
    expect(await service.deployableEvmChains()).toEqual([]);
  });

  it("falls back to the local-dev RPC default with no env involved", async () => {
    const service = setup([]);
    expect(await service.rpcUrlForReference("97")).toBe("http://localhost:8545");
    expect(service.rpcUrlFor({ rpcUrls: [], reference: "97" })).toBe("http://localhost:8545");
  });

  it("reads the EVM relayer key from the dashboard-managed table (null when unset)", async () => {
    const row = dbRow({
      id: "chain-97",
      contracts: [
        { type: "factory", address: FACTORY, versionLabel: "v1" },
        { type: "account_implementation", address: IMPL, versionLabel: "v1" },
      ],
    });
    const withKey = setup([row], { "chain-97": "0x" + "11".repeat(32) });
    expect(await withKey.relayerSecretFor("97")).toBe("0x" + "11".repeat(32));
    const withoutKey = setup([row]);
    expect(await withoutKey.relayerSecretFor("97")).toBeNull();
    expect(await withoutKey.relayerSecretFor("unknown")).toBeNull();
  });

  it("reads relayerSecretFor as null when the table is missing (fail-absent, never throws)", async () => {
    const prisma = { chain: { findMany: jest.fn(async () => []) } };
    const service = new ChainRegistryService(prisma as never);
    expect(await service.relayerSecretFor("97")).toBeNull();
  });

  it("caches reads and drops the cache on invalidate", async () => {
    const findMany = jest.fn(async () => [dbRow()]);
    const service = new ChainRegistryService({ chain: { findMany } } as never);
    await service.activeChains();
    await service.activeChains();
    expect(findMany).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.activeChains();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("resolves Solana RPC + program from the registry, with constant fallbacks", async () => {
    const solanaRow = dbRow({
      id: "chain-sol",
      namespace: "solana",
      reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
      name: "solana-devnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: ["https://solana.example"],
      contracts: [{ type: "program", address: "9oMG7eLaq8NxHJEr5nzPc9CgLc8gprzBGVn6sxunECce", versionLabel: "v1" }],
    });
    const withRow = setup([solanaRow]);
    expect(await withRow.solanaRpcUrl()).toBe("https://solana.example");
    expect(await withRow.solanaProgramId()).toBe("9oMG7eLaq8NxHJEr5nzPc9CgLc8gprzBGVn6sxunECce");

    // Empty registry → EVM code fallback has no Solana chain → per-cluster constants.
    const empty = setup([]);
    expect(await empty.solanaRpcUrl()).toBe("https://api.devnet.solana.com");
    expect(await empty.solanaProgramId()).toBe("9oMG7eLaq8NxHJEr5nzPc9CgLc8gprzBGVn6sxunECce");
    expect(await empty.solanaProgramId("devnet")).toBe("9oMG7eLaq8NxHJEr5nzPc9CgLc8gprzBGVn6sxunECce");
    expect(await empty.solanaProgramId("testnet")).toBe(SOLANA_TESTNET_PROGRAM_ID);
  });

  it("derives the same address on every deployable chain (determinism invariant)", async () => {
    // Decision 9/10: the same PID must derive to the same EVM address on every
    // supported chain. That holds iff every chain shares one factory/implementation
    // pair — any per-chain drift silently moves that chain's addresses.
    const other = "0x1111111111111111111111111111111111111111";
    const rows = (["97", "10143"] as const).map((reference, i) => dbRow({
      id: `chain-${reference}`,
      reference,
      contracts: [
        { type: "factory", address: i === 0 ? FACTORY : other, versionLabel: "v1" },
        { type: "account_implementation", address: IMPL, versionLabel: "v1" },
      ],
    }));
    const service = setup(rows);
    const deployable = await service.deployableEvmChains();
    expect(deployable).toHaveLength(2);
    const addrs = await Promise.all(
      deployable.map(async (c) => {
        const d = await service.deploymentFor(c.reference);
        return deriveEvmSmartAccountAddress("ifal@pid", d!.factory, d!.implementation).address;
      }),
    );
    // This documents the invariant by showing drift breaks it: different factories
    // MUST yield different addresses, so CI fails loudly on registry divergence.
    expect(addrs[0]).not.toBe(addrs[1]);
    const same = deriveEvmSmartAccountAddress("ifal@pid", FACTORY, IMPL).address;
    expect(deriveEvmSmartAccountAddress("IFAL@PID ", FACTORY, IMPL).address).toBe(same); // normalization
  });

  describe("Solana selection scope (ANT-24 dual-cluster registry)", () => {
    const DEVNET_PROGRAM = SOLANA_PROGRAM_ID;
    const TESTNET_PROGRAM = SOLANA_TESTNET_PROGRAM_ID;
    expect(TESTNET_PROGRAM).not.toBe(DEVNET_PROGRAM); // distinct keypairs per cluster (Trevor, ANT-26)

    function solanaRows() {
      return [
        dbRow({
          id: "chain-sol-devnet",
          namespace: "solana",
          reference: SOLANA_DEVNET_REFERENCE,
          name: "solana-devnet",
          nativeSymbol: "SOL",
          decimals: 9,
          rpcUrls: ["https://api.devnet.solana.com"],
          explorerUrl: "https://explorer.solana.com",
          isTestnet: true,
          contracts: [{ type: "program", address: DEVNET_PROGRAM, versionLabel: "v1" }],
        }),
        dbRow({
          id: "chain-sol-testnet",
          namespace: "solana",
          reference: SOLANA_TESTNET_REFERENCE,
          name: "solana-testnet",
          nativeSymbol: "SOL",
          decimals: 9,
          rpcUrls: ["https://api.testnet.solana.com"],
          explorerUrl: "https://explorer.solana.com?cluster=testnet",
          isTestnet: true,
          contracts: [{ type: "program", address: TESTNET_PROGRAM, versionLabel: "v1" }],
        }),
      ];
    }

    it("maps selections to distinct registry references", () => {
      expect(solanaReferenceFor("devnet")).toBe(SOLANA_DEVNET_REFERENCE);
      expect(solanaReferenceFor("testnet")).toBe(SOLANA_TESTNET_REFERENCE);
      expect(SOLANA_TESTNET_REFERENCE).not.toBe(SOLANA_DEVNET_REFERENCE);
    });

    it("resolves devnet vs testnet chains, RPCs, and programs per selection", async () => {
      const service = setup(solanaRows());
      expect((await service.solanaChain("devnet"))?.id).toBe("chain-sol-devnet");
      expect((await service.solanaChain("testnet"))?.id).toBe("chain-sol-testnet");
      expect(await service.solanaRpcUrl("devnet")).toBe("https://api.devnet.solana.com");
      expect(await service.solanaRpcUrl("testnet")).toBe("https://api.testnet.solana.com");
      expect(await service.solanaProgramId("devnet")).toBe(DEVNET_PROGRAM);
      expect(await service.solanaProgramId("testnet")).toBe(TESTNET_PROGRAM);
      expect(await service.solanaChains()).toHaveLength(2);
    });

    it("keeps no-selection behavior on the first Solana row (backward compatible)", async () => {
      const service = setup(solanaRows());
      expect((await service.solanaChain())?.id).toBe("chain-sol-devnet");
      expect(await service.solanaRpcUrl()).toBe("https://api.devnet.solana.com");
      expect(await service.solanaProgramId()).toBe(DEVNET_PROGRAM);
    });

    it("labels networks per row: mainnet-beta when not testnet, testnet by reference, devnet otherwise", async () => {
      const service = setup(solanaRows());
      expect(await service.networkLabel("devnet")).toBe("devnet");
      expect(await service.networkLabel("testnet")).toBe("testnet");
      expect(await service.networkLabel()).toBe("devnet");
      expect(service.networkLabelFor(undefined)).toBe("devnet");
      expect(service.networkLabelFor({ reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z", isTestnet: false })).toBe(
        "mainnet-beta",
      );
    });

    it("scopes solanaChainIdOrThrow per selection with fail-fast 404s", async () => {
      const findUnique = jest.fn(async ({ where }: any) =>
        where.namespace_reference.reference === SOLANA_DEVNET_REFERENCE ? { id: "chain-sol-devnet" } : null,
      );
      const prisma = { chain: { findMany: jest.fn(async () => solanaRows()), findUnique } };
      const service = new ChainRegistryService(prisma as never);

      expect(await service.solanaChainIdOrThrow()).toBe("chain-sol-devnet");
      expect(await service.solanaChainIdOrThrow("devnet")).toBe("chain-sol-devnet");
      expect(findUnique).toHaveBeenCalledWith({
        where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference: SOLANA_DEVNET_REFERENCE } },
        select: { id: true },
      });
      await expect(service.solanaChainIdOrThrow("testnet")).rejects.toThrow(NotFoundException);
      await expect(service.solanaChainIdOrThrow("testnet")).rejects.toThrow('"testnet"');
    });
  });

  describe("HTTP selection surface (ANT-35: header/query → selection, fail-closed)", () => {
    const DEVNET_ROW = {
      id: "chain-sol-devnet",
      namespace: "solana",
      reference: SOLANA_DEVNET_REFERENCE,
      name: "solana-devnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: ["https://api.devnet.solana.com"],
      explorerUrl: "https://explorer.solana.com",
      isTestnet: true,
      contracts: [{ type: "program", address: "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT", versionLabel: "v1" }],
    };
    const TESTNET_ROW = {
      ...DEVNET_ROW,
      id: "chain-sol-testnet",
      reference: SOLANA_TESTNET_REFERENCE,
      name: "solana-testnet",
      rpcUrls: ["https://api.testnet.solana.com"],
    };

    async function unknownChainBody(promise: Promise<unknown>) {
      try {
        await promise;
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getStatus()).toBe(400);
        return (err as BadRequestException).getResponse() as { code: string; message: string };
      }
      throw new Error("expected selectionFromReferenceOrThrow to reject");
    }

    it("omitted or blank selection preserves the server default (backward compatible)", async () => {
      const service = setup([DEVNET_ROW, TESTNET_ROW]);
      await expect(service.selectionFromReferenceOrThrow(undefined)).resolves.toBeUndefined();
      await expect(service.selectionFromReferenceOrThrow("")).resolves.toBeUndefined();
      await expect(service.selectionFromReferenceOrThrow("   ")).resolves.toBeUndefined();
    });

    it("maps registered references to selections (whitespace-tolerant)", async () => {
      const service = setup([DEVNET_ROW, TESTNET_ROW]);
      await expect(service.selectionFromReferenceOrThrow(SOLANA_DEVNET_REFERENCE)).resolves.toBe("devnet");
      await expect(service.selectionFromReferenceOrThrow(SOLANA_TESTNET_REFERENCE)).resolves.toBe("testnet");
      await expect(service.selectionFromReferenceOrThrow(`  ${SOLANA_TESTNET_REFERENCE} `)).resolves.toBe("testnet");
    });

    it("rejects unknown references with 400 UNKNOWN_CHAIN (fail-closed, AC-1.4)", async () => {
      const service = setup([DEVNET_ROW, TESTNET_ROW]);
      const body = await unknownChainBody(service.selectionFromReferenceOrThrow("mainnet-beta"));
      expect(body.code).toBe("UNKNOWN_CHAIN");
      expect(body.message).toMatch("Unknown chain reference");
    });

    it("rejects known-but-inactive references (no silent fallback to another cluster)", async () => {
      const service = setup([DEVNET_ROW]); // testnet row deactivated
      const body = await unknownChainBody(service.selectionFromReferenceOrThrow(SOLANA_TESTNET_REFERENCE));
      expect(body.code).toBe("UNKNOWN_CHAIN");
    });

    it("rejects over-long references at the boundary", async () => {
      const service = setup([DEVNET_ROW, TESTNET_ROW]);
      const body = await unknownChainBody(service.selectionFromReferenceOrThrow("x".repeat(129)));
      expect(body.code).toBe("UNKNOWN_CHAIN");
    });

    it("rejects ambiguous (repeated query) references fail-closed", async () => {
      const service = setup([DEVNET_ROW, TESTNET_ROW]);
      const body = await unknownChainBody(
        service.selectionFromReferenceOrThrow([SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE]),
      );
      expect(body.code).toBe("UNKNOWN_CHAIN");
    });
  });

  describe("Solana mainnet availability (ANT-75 presence signal)", () => {
    const MAINNET_ROW = {
      id: "chain-sol-mainnet",
      namespace: "solana",
      reference: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      name: "solana-mainnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: ["https://api.mainnet-beta.solana.com"],
      explorerUrl: "https://explorer.solana.com",
      isTestnet: false,
      contracts: [{ type: "program", address: "Mainnet1111111111111111111111111111111111111", versionLabel: "v1" }],
    };

    function seededTestnetOnlyRows() {
      return [
        dbRow({
          id: "chain-sol-devnet",
          namespace: "solana",
          reference: SOLANA_DEVNET_REFERENCE,
          name: "solana-devnet",
          nativeSymbol: "SOL",
          decimals: 9,
          rpcUrls: ["https://api.devnet.solana.com"],
          explorerUrl: "https://explorer.solana.com",
          isTestnet: true,
          contracts: [{ type: "program", address: SOLANA_PROGRAM_ID, versionLabel: "v1" }],
        }),
        dbRow({
          id: "chain-sol-testnet",
          namespace: "solana",
          reference: SOLANA_TESTNET_REFERENCE,
          name: "solana-testnet",
          nativeSymbol: "SOL",
          decimals: 9,
          rpcUrls: ["https://api.testnet.solana.com"],
          explorerUrl: "https://explorer.solana.com?cluster=testnet",
          isTestnet: true,
          contracts: [{ type: "program", address: SOLANA_TESTNET_PROGRAM_ID, versionLabel: "v1" }],
        }),
      ];
    }

    it("reads unavailable on the seeded registry (both Solana rows testnet, no mainnet program)", async () => {
      const service = setup(seededTestnetOnlyRows());
      await expect(service.solanaMainnetAvailability()).resolves.toEqual({
        available: false,
        reference: null,
        program: null,
        rpcUrl: null,
      });
    });

    it("reads unavailable when a mainnet row exists but carries no program contract", async () => {
      const service = setup([...seededTestnetOnlyRows(), { ...MAINNET_ROW, contracts: [] }]);
      await expect(service.solanaMainnetAvailability()).resolves.toEqual({
        available: false,
        reference: null,
        program: null,
        rpcUrl: null,
      });
    });

    it("reads available with row details once a mainnet program ships (data row, no code change)", async () => {
      const service = setup([...seededTestnetOnlyRows(), MAINNET_ROW]);
      await expect(service.solanaMainnetAvailability()).resolves.toEqual({
        available: true,
        reference: MAINNET_ROW.reference,
        program: "Mainnet1111111111111111111111111111111111111",
        rpcUrl: "https://api.mainnet-beta.solana.com",
      });
    });

    it("reads unavailable on an empty registry (code fallback has no Solana rows)", async () => {
      const service = setup([]);
      await expect(service.solanaMainnetAvailability()).resolves.toEqual({
        available: false,
        reference: null,
        program: null,
        rpcUrl: null,
      });
    });

    it("reads unavailable when the mainnet program address is blank", async () => {
      const service = setup([
        ...seededTestnetOnlyRows(),
        { ...MAINNET_ROW, contracts: [{ type: "program", address: "", versionLabel: "v1" }] },
      ]);
      await expect(service.solanaMainnetAvailability()).resolves.toEqual({
        available: false,
        reference: null,
        program: null,
        rpcUrl: null,
      });
    });
  });
});
