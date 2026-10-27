import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { keccak256, fromAscii, toHex } from "@peridotvault/pid-evm";
import { EvmActivationService } from "./evm-activation.service";
import { mockSecurity, mockIdempotency, mockBreaker, COSE_HEX } from "../../test/factories";
import { coseToRawXy } from "../credentials/cose";

const IDENTITY_ID = "pid_01HASH";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPL = "0x0000000000000000000000000000000000000001";

// eth_* responses by method; tweaked per test.
let code = "0x";
let balance = "0x0";
let gasPrice = "0x3b9aca00"; // 1 gwei
// eth_call overrides by calldata; default = exact authority match.
let viewOverrides: Record<string, string> = {};

const sel = (sig: string) => `0x${toHex(keccak256(fromAscii(sig)).subarray(0, 4))}`;
const word = (hex: string) => `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
const CRED = coseToRawXy(Buffer.from(COSE_HEX, "hex"));

function defaultView(data: string): string {
  if (data === sel("initialized()")) return word("1");
  if (data === sel("factory()")) return word(FACTORY);
  if (data === sel("authorityX()")) return word(toHex(new Uint8Array(CRED.x)));
  if (data === sel("authorityY()")) return word(toHex(new Uint8Array(CRED.y)));
  return word("0");
}

function mockFetch() {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
    const { method, params } = JSON.parse((opts as { body: string }).body) as {
      method: string;
      params?: Array<{ data?: string }>;
    };
    const result =
      method === "eth_getCode"
        ? code
        : method === "eth_getBalance"
          ? balance
          : method === "eth_getBlockByNumber"
            ? { timestamp: "0x3b9aca00" }
            : method === "eth_call"
              ? (viewOverrides[params?.[0]?.data ?? ""] ?? defaultView(params?.[0]?.data ?? ""))
              : gasPrice;
    return { ok: true, json: async () => ({ result }) };
  });
}

function chainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evm-chain-1",
    pid: IDENTITY_ID,
    chainId: "chain-97",
    chain: { namespace: "eip155", reference: "97" },
    address: "0x883c7FcF54967D2Fc3F769E44Cd78f74560909D6",
    accountType: "smart_account",
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date()
    ,
    ...overrides,
  };
}

function setup(relayerSecret?: string, fees?: unknown) {
  // ANT-193: no EVM_* env — factory/impl/RPC come from the chains mock (DB
  // rows in prod), the relayer key from relayerSecretFor (evm_relayer_keys).
  const values: Record<string, string> = {
    WEBAUTHN_RP_ID: "localhost",
  };
  const config = {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    }),
  };
  const security = mockSecurity();
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
    relayerSecretFor: jest.fn(async () => relayerSecret ?? null),
    invalidate: jest.fn(),
  };
  const service = new EvmActivationService(prisma as never, config as never, security as never, chains as never, mockIdempotency() as never, mockBreaker() as never, fees as never);
  return { service, prisma, config, security };
}

beforeEach(() => {
  code = "0x";
  balance = "0x0";
  gasPrice = "0x3b9aca00";
  viewOverrides = {};
  mockFetch();
});

describe("EvmActivationService", () => {
  it("viewOf reports active when code is deployed", async () => {
    code = "0x6080604052";
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID }, "97");
    expect(view.status).toBe("active");
    expect(view.deployed).toBe(true);
  });

  it("viewOf does not promote on authority mismatch (squat)", async () => {
    code = "0x6080604052";
    balance = "0x" + (10n ** 18n).toString(16); // funded → would be ready
    viewOverrides[sel("authorityX()")] = word("deadbeef");
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID }, "97");
    expect(view.deployed).toBe(true);
    expect(view.status).not.toBe("active");
  });

  it("poll promotes on exact match and demotes mismatched active rows", async () => {
    code = "0x6080604052";
    const { service, prisma } = setup();
    (prisma.chainAccount.findMany as jest.Mock).mockResolvedValueOnce([chainRow({ status: "ready" })]);
    await service.poll();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "active" } }),
    );
    (prisma.chainAccount.update as jest.Mock).mockClear();
    viewOverrides[sel("authorityY()")] = word("deadbeef");
    (prisma.chainAccount.findMany as jest.Mock).mockResolvedValueOnce([chainRow({ status: "active" })]);
    await service.poll();
    expect(prisma.chainAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ready" } }),
    );
  });

  it("viewOf reports inactivated on empty account", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID }, "97");
    expect(view.status).toBe("inactivated");
    expect(view.balanceWei).toBe("0");
    expect(BigInt(view.requiredWei)).toBeGreaterThan(0n);
  });

  it("viewOf rejects unknown chains", async () => {
    const { service } = setup();
    await expect(service.viewOf({ pid: IDENTITY_ID }, "1")).rejects.toThrow("Unsupported EVM chain");
  });

  it("activate refuses when no relayer key is configured", async () => {
    balance = "0x" + (10n ** 18n).toString(16); // funded
    const { service } = setup(); // no relayer secret
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("activate refuses a non-ready account", async () => {
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(ConflictException);
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
      const { method, params } = JSON.parse((opts as { body: string }).body) as {
        method: string;
        params?: Array<{ data?: string }>;
      };
      const result =
        method === "eth_getCode"
          ? deployed
            ? "0x6080604052"
            : "0x"
          : method === "eth_getBalance"
            ? balance
            : method === "eth_getBlockByNumber"
              ? { timestamp: "0x3b9aca00" }
              : method === "eth_call"
                ? defaultView(params?.[0]?.data ?? "")
                : gasPrice;
      return { ok: true, json: async () => ({ result }) };
    });
    const view = await service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    });
    expect(view.status).toBe("active");
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ chain: "eip155", asset: "tBNB" }) }),
    );
  });

  it("activate emits canonical H2/H1 rows on deploy (chain 97 buckets to unknown)", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service, security } = setup("0x" + "11".repeat(32));
    let deployed = false;
    (service as unknown as { sendDeployTx: jest.Mock }).sendDeployTx = jest.fn(async () => {
      deployed = true;
      return { hash: "0xdeploy", from: "0xrelayer", costWei: "100000000000000" };
    });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
      const { method, params } = JSON.parse((opts as { body: string }).body) as {
        method: string;
        params?: Array<{ data?: string }>;
      };
      const result =
        method === "eth_getCode"
          ? deployed
            ? "0x6080604052"
            : "0x"
          : method === "eth_getBalance"
            ? balance
            : method === "eth_getBlockByNumber"
              ? { timestamp: "0x3b9aca00" }
              : method === "eth_call"
                ? defaultView(params?.[0]?.data ?? "")
                : gasPrice;
      return { ok: true, json: async () => ({ result }) };
    });
    await service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    });
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relay.resolve_landed",
      expect.objectContaining({ chain: "unknown", entryPoint: "activate", signature: "0xdeploy" }),
    );
    // attested 350000×1e9 = 350000000000000 vs actual cost 100000000000000 → over-attested.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "relayer.pnl",
      expect.objectContaining({
        chain: "unknown",
        entryPoint: "activate",
        signature: "0xdeploy",
        absorbed: "0",
        attested: "350000000000000",
        actual: "100000000000000",
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "reconcile.over_attested",
      expect.objectContaining({
        chain: "unknown",
        entryPoint: "activate",
        signature: "0xdeploy",
        attested: "350000000000000",
        actual: "100000000000000",
        expected: "100000000000000",
        absorbed: "0",
      }),
    );
  });

  it("activate rejects drift beyond 120% of the quoted network fee", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service, security } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(ConflictException);
    // H1.v + H1.ii: drift pair with the exact contract keys.
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "quote.drift_rejected",
      expect.objectContaining({
        chain: "unknown",
        entryPoint: "activate",
        quoted: "1",
        attested: "350000000000000",
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      "intent.rejected",
      expect.objectContaining({ chain: "unknown", entryPoint: "activate", cause: "drift" }),
    );
  });

  it("activate accepts attestation at exactly 120% of the quote", async () => {
    // attested 350000×1e9 = 350000000000000 vs quoted 291666666666667:
    // 350000000000000×100 == 3.5e16 < 291666666666667×120 == 35000000000000040.
    balance = "0x" + (10n ** 18n).toString(16);
    const { service, prisma } = setup("0x" + "11".repeat(32));
    let deployed = false;
    (service as unknown as { sendDeployTx: jest.Mock }).sendDeployTx = jest.fn(async () => {
      deployed = true;
      return { hash: "0xdeploy", from: "0xrelayer", costWei: "100000000000000", l1FeeWei: "0" };
    });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
      const { method, params } = JSON.parse((opts as { body: string }).body) as {
        method: string;
        params?: Array<{ data?: string }>;
      };
      const result =
        method === "eth_getCode"
          ? deployed
            ? "0x6080604052"
            : "0x"
          : method === "eth_getBalance"
            ? balance
            : method === "eth_getBlockByNumber"
              ? { timestamp: "0x3b9aca00" }
              : method === "eth_call"
                ? defaultView(params?.[0]?.data ?? "")
                : method === "eth_getTransactionByHash"
                  ? { input: "0x1234" }
                  : gasPrice;
      return { ok: true, json: async () => ({ result }) };
    });
    const view = await service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "291666666666667",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    });
    expect(view.status).toBe("active");
    expect(prisma.transaction.create).toHaveBeenCalled();
  });

  it("activate rejects attestation one unit above the 120% boundary", async () => {
    // 350000000000000×100 == 3.5e16 > 291666666666666×120 == 34999999999999920.
    balance = "0x" + (10n ** 18n).toString(16);
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "291666666666666",
      feePolicyVersion: 1,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(ConflictException);
  });

  it("activate rejects an over-TTL deadline", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 1,
      deadline: 1000000901,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(BadRequestException);
  });

  it("viewOf quotes V4 policy 2 pure percentage with suggested maxTotalFee (B5)", async () => {
    const { service } = setup();
    const view = await service.viewOf({ pid: IDENTITY_ID }, "97");
    expect(view.feePolicyVersion).toBe(2);
    // 350k gas × 1 gwei = 350_000_000_000_000 network; pure 50% = 175e12.
    expect(view.networkFeeWei).toBe("350000000000000");
    expect(view.totalFeeWei).toBe("525000000000000");
    expect(view.maxTotalFeeWei).toBe(view.totalFeeWei);
    expect(view.requiredWei).toBe(view.totalFeeWei);
  });

  it("activate with policy 2 deploys via V4 and enforces maxTotalFee (B6)", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service, prisma } = setup("0x" + "11".repeat(32));
    let deployed = false;
    let calldata = "";
    (service as unknown as { sendDeployTx: jest.Mock }).sendDeployTx = jest.fn(async (_ref: string, _sec: string, data: string) => {
      deployed = true;
      calldata = data;
      return { hash: "0xdeployV4", from: "0xrelayer", costWei: "100000000000000", l1FeeWei: "0" };
    });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: unknown, opts: unknown) => {
      const { method, params } = JSON.parse((opts as { body: string }).body) as {
        method: string;
        params?: Array<{ data?: string }>;
      };
      const result =
        method === "eth_getCode"
          ? deployed
            ? "0x6080604052"
            : "0x"
          : method === "eth_getBalance"
            ? balance
            : method === "eth_getBlockByNumber"
              ? { timestamp: "0x3b9aca00" }
              : method === "eth_call"
                ? defaultView(params?.[0]?.data ?? "")
                : gasPrice;
      return { ok: true, json: async () => ({ result }) };
    });
    const view = await service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 2,
      maxTotalFeeWei: "525000000000000",
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    });
    expect(view.status).toBe("active");
    // deployAndInitV4 selector (fee-capped activation), not V3.
    expect(calldata.slice(0, 10).toLowerCase()).not.toBe("0x00000000");
    expect(prisma.transaction.create).toHaveBeenCalled();
  });

  it("activate with policy 2 requires maxTotalFeeWei", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 2,
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(/maxTotalFee/i);
  });

  it("activate with policy 2 rejects total above maxTotalFee (FeeExceedsMax)", async () => {
    balance = "0x" + (10n ** 18n).toString(16);
    const { service } = setup("0x" + "11".repeat(32));
    await expect(service.activate({ pid: IDENTITY_ID }, "97", {
      quotedNetworkFeeWei: "1000000000000000",
      feePolicyVersion: 2,
      maxTotalFeeWei: "1",
      deadline: 1000000300,
      assertion: {
        id: "cred-1",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        authenticatorData: "00".repeat(37),
        clientDataJSON: Buffer.from("{}").toString("base64url"),
      },
    })).rejects.toThrow(/maxTotalFee/i);
  });
});

describe("EvmActivationService — DB fee legs ignored (ANT-743 pure percentage)", () => {
  const DB_MIN = 10n ** 18n; // above any percentage leg at 1 gwei — proves the DB leg is ignored
  const dbFees = {
    activePolicy: jest.fn<Promise<{ version: number; bps: number }>, []>(),
    minFeeForVersion: jest.fn<Promise<{ minFee: bigint; bps: number }>, []>(),
    checkSubmitVersion: jest.fn<Promise<unknown>, []>(),
    recordSubsidy: jest.fn<Promise<void>, []>(),
  };

  beforeEach(() => {
    dbFees.activePolicy.mockResolvedValue({ version: 2, bps: 5000 });
    dbFees.minFeeForVersion.mockResolvedValue({ minFee: DB_MIN, bps: 5000 });
    dbFees.checkSubmitVersion.mockResolvedValue({ ok: true as const });
    dbFees.recordSubsidy.mockResolvedValue(undefined);
  });

  it("viewOf separates network vs service fee (pure 50%, DB leg ignored)", async () => {
    const { service } = setup(undefined, dbFees);
    const view = await service.viewOf({ pid: IDENTITY_ID }, "97");
    // network = 350000 × 1 gwei = 3.5e14; service = pure 50% = 1.75e14 (DB 1e18 leg ignored).
    expect(view.feePolicyVersion).toBe(2);
    expect(view.networkFeeWei).toBe("350000000000000");
    expect(view.serviceFeeWei).toBe("175000000000000");
    expect(view.chainMinBaseUnits).toBe("0");
    expect(view.platformFee).toBe("175000000000000");
    expect(view.networkFee).toBe("350000000000000");
    expect(view.totalFee).toBe("525000000000000");
    expect(view.totalFeeWei).toBe("525000000000000");
    expect(view.requiredWei).toBe("525000000000000");
    expect(view.protocolFeeBps).toBe(5000);
  });

  it("activate rejects a superseded version as StaleQuote (410)", async () => {
    // Pure-percentage leg so the account classifies READY and reaches the gate.
    dbFees.minFeeForVersion.mockResolvedValue({ minFee: 2_300_000_000_000n, bps: 5000 });
    dbFees.checkSubmitVersion.mockResolvedValue({
      ok: false as const,
      code: "StaleQuote",
      status: 410 as const,
      message: "Fee policy superseded — re-quote and try again",
    });
    balance = "0x" + (525_000_000_000_000n).toString(16); // frozen total at 1 gwei
    const { service, security } = setup("0x" + "11".repeat(32), dbFees);
    const err = await service
      .activate({ pid: IDENTITY_ID }, "97", {
        quotedNetworkFeeWei: "350000000000000",
        feePolicyVersion: 2,
        maxTotalFeeWei: "525000000000000",
        deadline: 1000000300,
        assertion: {
          id: "cred-1",
          r: "0x" + "11".repeat(32),
          s: "0x" + "22".repeat(32),
          authenticatorData: "00".repeat(37),
          clientDataJSON: Buffer.from("{}").toString("base64url"),
        },
      })
      .catch((e) => e);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toMatchObject({ code: "StaleQuote" });
    expect(security.log).toHaveBeenCalledWith(
      IDENTITY_ID,
      expect.anything(),
      expect.objectContaining({ entryPoint: "activate", cause: "policy-unknown" }),
    );
  });
});
