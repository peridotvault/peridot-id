import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { EvmActivationService } from "./evm-activation.service";

// Same valid ES256 COSE_Key as activation.service.spec (x/y present for EVM init).
const COSE_HEX =
  "a5010203262001215820c728cac553ac9c7e6741694959adfbc1b5466df7071c8ea40fa05782c9628b8422582074d2fa89ce2b706497759bb98da015280bb379675f3476a378a6ce8a220ba639";

const ACCOUNT_ID = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";
const IDENTITY_ID = "pid_01HASH";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPL = "0x0000000000000000000000000000000000000001";

// eth_* responses by method; tweaked per test.
let code = "0x";
let balance = "0x0";
let gasPrice = "0x3b9aca00"; // 1 gwei

function mockFetch() {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
    const { method } = JSON.parse((opts as { body: string }).body) as { method: string };
    const result = method === "eth_getCode" ? code : method === "eth_getBalance" ? balance : gasPrice;
    return { ok: true, json: async () => ({ result }) };
  });
}

function chainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evm-chain-1",
    accountId: ACCOUNT_ID,
    chainNamespace: "eip155",
    chainReference: "97",
    address: "0x883c7FcF54967D2Fc3F769E44Cd78f74560909D6",
    accountType: "smart_account",
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    account: { id: ACCOUNT_ID, identityId: IDENTITY_ID, status: "active" },
    ...overrides,
  };
}

function setup(relayerSecret?: string) {
  const values: Record<string, string> = {
    EVM_FACTORY_ADDRESS: FACTORY,
    EVM_IMPLEMENTATION_ADDRESS: IMPL,
    EVM_RPC_URL: "http://localhost:8545",
    WEBAUTHN_RP_ID: "localhost",
    PID_ACTIVATION_MARGIN_RATE: "0.5",
  };
  if (relayerSecret) values.EVM_RELAYER_SECRET = relayerSecret;
  const config = {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    }),
  };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => chainRow()),
      findMany: jest.fn(async () => [] as unknown[]),
      update: jest.fn(async (args: unknown) => args),
    },
    authority: {
      findFirst: jest.fn(async () => ({ publicKey: Buffer.from(COSE_HEX, "hex") })),
    },
    transaction: { create: jest.fn(async () => ({})) },
  };
  const chains = {
    activeChains: jest.fn(async () => [
      {
        id: "chain-97",
        namespace: "eip155",
        reference: "97",
        name: "bsc-testnet",
        nativeSymbol: "tBNB",
        decimals: 18,
        rpcUrls: ["http://localhost:8545"],
        explorerUrl: null,
        logoUrl: null,
        isTestnet: true,
        contracts: [
          { type: "factory", address: FACTORY, versionLabel: "v1" },
          { type: "account_implementation", address: IMPL, versionLabel: "v1" },
        ],
      },
    ]),
    deployableEvmChains: jest.fn(async () => []),
    deploymentFor: jest.fn(async (ref: string) =>
      ref === "97" ? { factory: FACTORY, implementation: IMPL } : null,
    ),
    chainByReference: jest.fn(async (ref: string) =>
      ref === "97"
        ? {
            id: "chain-97",
            namespace: "eip155",
            reference: "97",
            name: "bsc-testnet",
            nativeSymbol: "tBNB",
            decimals: 18,
            rpcUrls: ["http://localhost:8545"],
            explorerUrl: null,
            logoUrl: null,
            isTestnet: true,
            contracts: [],
          }
        : undefined,
    ),
    rpcUrlForReference: jest.fn(async () => "http://localhost:8545"),
    rpcUrlFor: jest.fn(() => "http://localhost:8545"),
    invalidate: jest.fn(),
  };
  const service = new EvmActivationService(prisma as never, config as never, security as never, chains as never);
  return { service, prisma, config, security };
}

beforeEach(() => {
  code = "0x";
  balance = "0x0";
  gasPrice = "0x3b9aca00";
  mockFetch();
});

describe("EvmActivationService", () => {
  it("viewOf reports active when code is deployed", async () => {
    code = "0x6080604052";
    const { service } = setup();
    const view = await service.viewOf({ identityId: IDENTITY_ID }, ACCOUNT_ID, "97");
    expect(view.status).toBe("active");
    expect(view.deployed).toBe(true);
  });

  it("viewOf reports inactivated on empty account", async () => {
    const { service } = setup();
    const view = await service.viewOf({ identityId: IDENTITY_ID }, ACCOUNT_ID, "97");
    expect(view.status).toBe("inactivated");
    expect(view.balanceWei).toBe("0");
    expect(BigInt(view.requiredWei)).toBeGreaterThan(0n);
  });

  it("viewOf rejects unknown chains", async () => {
    const { service } = setup();
    await expect(service.viewOf({ identityId: IDENTITY_ID }, ACCOUNT_ID, "1")).rejects.toThrow("Unsupported EVM chain");
  });

  it("activate refuses when no relayer key is configured", async () => {
    balance = "0x" + (10n ** 18n).toString(16); // funded
    const { service } = setup(); // no relayer secret
    await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID, "97")).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("activate refuses a non-ready account", async () => {
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID, "97")).rejects.toThrow(ConflictException);
  });

  it("activate deploys via the relayer and marks active", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service, prisma } = setup("0x" + "11".repeat(32));
    let deployed = false;
    (service as unknown as { sendDeployTx: jest.Mock }).sendDeployTx = jest.fn(async () => {
      deployed = true; // after deploy the node reports code → final viewOf is active
      return { hash: "0xdeploy", from: "0xrelayer", costWei: "100000000000000" };
    });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
      const { method } = JSON.parse((opts as { body: string }).body) as { method: string };
      const result =
        method === "eth_getCode" ? (deployed ? "0x6080604052" : "0x") : method === "eth_getBalance" ? balance : gasPrice;
      return { ok: true, json: async () => ({ result }) };
    });
    const view = await service.activate({ identityId: IDENTITY_ID }, ACCOUNT_ID, "97");
    expect(view.status).toBe("active");
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ chain: "eip155", asset: "tBNB" }) }),
    );
  });
});
