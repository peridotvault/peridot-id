// Chain fee-policy service tests (ANT-730, spec ANT-727 §4).
// DB-first MIN_FEE per chain with frozen-table fallback; versioned rows that
// are never mutated; submit-time version gate (NFR-6/AC-11); floor validation
// on admin writes (AC-10); public read view (AC-18).
import { Prisma } from "@prisma/client";
import { FeePolicyService } from "./fee-policy.service";
import { SOLANA_DEVNET_REFERENCE, SOLANA_NAMESPACE, SOLANA_TESTNET_REFERENCE, STELLAR_NAMESPACE, STELLAR_TESTNET_REFERENCE } from "../common/chains";
import { platformFeeWithMin } from "../common/solana-relay";

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    bps: 5000,
    active: true,
    fxSource: "CoinGecko USD/IDR",
    fxAsOf: new Date("2026-10-27T00:00:00Z"),
    createdAt: new Date("2026-10-27T00:00:00Z"),
    updatedAt: new Date("2026-10-27T00:00:00Z"),
    minima: [
      { namespace: "eip155", reference: "84532", minFee: 750_000_000_000n },
      { namespace: "eip155", reference: "97", minFee: 2_300_000_000_000n },
      { namespace: "eip155", reference: "10143", minFee: 0n },
      { namespace: "eip155", reference: "421614", minFee: 0n },
      { namespace: "solana", reference: SOLANA_DEVNET_REFERENCE, minFee: 17_000n },
      { namespace: "solana", reference: SOLANA_TESTNET_REFERENCE, minFee: 17_000n },
    ],
    ...overrides,
  };
}

function v1Row() {
  return {
    version: 1,
    bps: 5000,
    active: false,
    fxSource: "FALLBACK_STATIC",
    fxAsOf: null,
    createdAt: new Date("2026-10-27T00:00:00Z"),
    updatedAt: new Date("2026-10-27T00:00:00Z"),
    minima: [],
  };
}

function setup(rows: unknown[] | Error) {
  const prisma = {
    chainFeePolicy: {
      findMany: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      }),
      findUnique: jest.fn(async ({ where }: { where: { version: number } }) => {
        if (rows instanceof Error) throw rows;
        return (rows as ReturnType<typeof policyRow>[]).find((r) => r.version === where.version) ?? null;
      }),
      findFirst: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return (rows as ReturnType<typeof policyRow>[]).find((r) => r.active) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: { version: number; bps: number } }) => data),
      update: jest.fn(async ({ data }: { data: unknown }) => data),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    relayerSubsidyLedger: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sub-1", ...data })),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
    $queryRaw: jest.fn(async () => []),
  };
  const security = { log: jest.fn(async () => undefined) };
  const service = new FeePolicyService(prisma as never, security as never);
  return { service, prisma, security };
}

describe("FeePolicyService — DB-first reads", () => {
  it("serves MIN_FEE from DB rows (AC-7 vectors)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    // Solana: network 5_000 lamports → floor 17_000 wins.
    const sol = await service.minFeeFor(SOLANA_NAMESPACE, SOLANA_DEVNET_REFERENCE);
    expect(sol).toEqual({ minFee: 17_000n, version: 2, bps: 5000 });
    expect(platformFeeWithMin(5_000n, sol.bps, sol.minFee)).toBe(17_000n);
    // Base Sepolia: network 200 gwei → floor 750 gwei wins.
    const base = await service.minFeeFor("eip155", "84532");
    expect(base.minFee).toBe(750_000_000_000n);
    expect(platformFeeWithMin(200_000_000_000n, base.bps, base.minFee)).toBe(750_000_000_000n);
    // BSC: network 2.1M gwei-wei → floor 2.3T wins.
    const bsc = await service.minFeeFor("eip155", "97");
    expect(platformFeeWithMin(2_100_000_000_000n, bsc.bps, bsc.minFee)).toBe(2_300_000_000_000n);
  });

  it("reads 0 for Monad/Arbitrum Sepolia (spec §4.4, AC-14)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    for (const ref of ["10143", "421614"]) {
      const m = await service.minFeeFor("eip155", ref);
      expect(m.minFee).toBe(0n);
      expect(platformFeeWithMin(1_000_000_000n, m.bps, m.minFee)).toBe(500_000_000n);
    }
  });

  it("settles submits under the signed version (v1 keeps v1 math)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    const v1 = await service.minFeeForVersion("solana", SOLANA_DEVNET_REFERENCE, 1);
    expect(v1).toEqual({ minFee: 0n, bps: 5000 });
  });

  it("falls back to the frozen table when the DB is unavailable", async () => {
    const { service } = setup(new Error("relation does not exist"));
    const sol = await service.minFeeFor(SOLANA_NAMESPACE, SOLANA_DEVNET_REFERENCE);
    expect(sol).toEqual({ minFee: 17_000n, version: 2, bps: 5000 });
    // Spec §4.4 override lives in the service: Monad/Arb read 0 even though
    // the frozen EVM fallback would hand them the Ethereum floor.
    expect((await service.minFeeFor("eip155", "10143")).minFee).toBe(0n);
    expect((await service.minFeeFor("eip155", "421614")).minFee).toBe(0n);
  });

  it("caches for 30s and refetches after invalidate (AC-9)", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    await service.minFeeFor("eip155", "97");
    await service.minFeeFor("eip155", "97");
    expect(prisma.chainFeePolicy.findMany).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.minFeeFor("eip155", "97");
    expect(prisma.chainFeePolicy.findMany).toHaveBeenCalledTimes(2);
  });

  it("exposes the public read view (AC-18)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    const view = await service.publicView();
    expect(view.version).toBe(2);
    expect(view.bps).toBe(5000);
    expect(view.minFee["eip155:84532"]).toBe("750000000000");
    expect(view.minFee["eip155:10143"]).toBe("0");
    expect(view.minFee[`solana:${SOLANA_DEVNET_REFERENCE}`]).toBe("17000");
    expect(view.fxSource).toBe("CoinGecko USD/IDR");
    expect(view.fxAsOf).toBe("2026-10-27T00:00:00.000Z");
  });
});

describe("FeePolicyService — submit version gate (NFR-6/AC-11)", () => {
  it("accepts the active version cleanly", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    expect(await service.checkSubmitVersion(2)).toEqual({ ok: true });
  });

  it("accepts one version back with a warning", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    const gate = await service.checkSubmitVersion(1);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.warning).toMatch(/v1.*v2/);
  });

  it("rejects versions more than one back as StaleQuote (410)", async () => {
    const v3 = policyRow({ version: 3, active: true });
    const v2 = policyRow({ version: 2, active: false });
    const { service } = setup([v1Row(), v2, v3]);
    expect(await service.checkSubmitVersion(1)).toEqual({
      ok: false,
      code: "StaleQuote",
      status: 410,
      message: "Fee policy superseded — re-quote and try again",
    });
  });

  it("rejects unknown and future versions as UnknownFeePolicy (400)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    for (const v of [0, 99]) {
      expect(await service.checkSubmitVersion(v)).toEqual({
        ok: false,
        code: "UnknownFeePolicy",
        status: 400,
        message: "Unsupported fee policy — re-quote and try again",
      });
    }
  });
});

describe("FeePolicyService — admin writes", () => {
  it("rejects minima below the settlement floor (AC-10)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    await expect(
      service.createPolicy("admin@pid", {
        bps: 5000,
        minima: [{ namespace: "eip155", reference: "97", minFee: "1" }],
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "ChainMinBelowFloor" }) });
  });

  it("rejects bps above the protocol maximum", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    await expect(
      service.createPolicy("admin@pid", { bps: 5001, minima: [] }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "FeeBpsOutOfRange" }) });
  });

  it("rejects bps=0 — no zero-fee policy without a reviewed exception (ANT-732 LOW)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    await expect(
      service.createPolicy("admin@pid", { bps: 0, minima: [] }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "FeeBpsOutOfRange" }) });
  });

  it("rejects duplicate minima legs with 400, never P2002 (ANT-732 LOW)", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    await expect(
      service.createPolicy("admin@pid", {
        bps: 5000,
        minima: [
          { namespace: "eip155", reference: "10143", minFee: "5" },
          { namespace: "eip155", reference: "10143", minFee: "6" },
        ],
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "DuplicateChainMin" }) });
    expect(prisma.chainFeePolicy.create).not.toHaveBeenCalled();
  });

  it("retries version=max+1 races instead of surfacing P2002 (ANT-732 LOW)", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    prisma.chainFeePolicy.create.mockRejectedValueOnce(p2002);
    prisma.chainFeePolicy.create.mockResolvedValueOnce({ version: 3, bps: 5000 });
    const created = await service.createPolicy("admin@pid", {
      bps: 5000,
      minima: [{ namespace: "eip155", reference: "84532", minFee: "750000000000" }],
    });
    expect(created.version).toBe(3);
    expect(prisma.chainFeePolicy.create).toHaveBeenCalledTimes(2);
  });

  it("accepts the stellar namespace (seed parity) with its floor enforced (ANT-732 LOW)", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    // Below the 100_000-stroop floor → rejected.
    await expect(
      service.createPolicy("admin@pid", {
        bps: 5000,
        minima: [{ namespace: STELLAR_NAMESPACE, reference: STELLAR_TESTNET_REFERENCE, minFee: "1" }],
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "ChainMinBelowFloor" }) });
    // At the floor → accepted and stored.
    const created = await service.createPolicy("admin@pid", {
      bps: 5000,
      minima: [{ namespace: STELLAR_NAMESPACE, reference: STELLAR_TESTNET_REFERENCE, minFee: "100000" }],
    });
    expect(created.version).toBe(3);
    expect(prisma.chainFeePolicy.create).toHaveBeenCalled();
  });

  it("publishes new versions inactive with an audit event", async () => {
    const { service, prisma, security } = setup([v1Row(), policyRow()]);
    const created = await service.createPolicy("admin@pid", {
      bps: 5000,
      minima: [{ namespace: "eip155", reference: "84532", minFee: "750000000000" }],
      fxSource: "CoinGecko USD/IDR",
    });
    expect(created).toEqual({ version: 3, bps: 5000, active: false });
    expect(prisma.chainFeePolicy.create).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith("admin@pid", "admin.fee_policy.created", {
      version: 3,
      bps: 5000,
      chainCount: 1,
    });
  });

  it("activates one version and records the previous one", async () => {
    const { service, prisma, security } = setup([v1Row(), policyRow()]);
    const out = await service.activatePolicy("admin@pid", 2);
    expect(out).toEqual({ version: 2, previousVersion: 2 });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(security.log).toHaveBeenCalledWith("admin@pid", "admin.fee_policy.activated", {
      version: 2,
      previousVersion: 2,
    });
  });

  it("rejects activation of an unknown version", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    await expect(service.activatePolicy("admin@pid", 99)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UnknownFeePolicy" }),
    });
  });
});

describe("FeePolicyService — subsidy ledger", () => {
  it("records quoted-vs-actual with subsidy = actual − quoted", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    await service.recordSubsidy({
      pid: "user@pid",
      namespace: "eip155",
      reference: "84532",
      kind: "activation",
      quotedFee: 100n,
      actualCost: 90n,
      txHash: "0xabc",
    });
    expect(prisma.relayerSubsidyLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quotedFee: 100n, actualCost: 90n, subsidy: -10n, txHash: "0xabc" }),
    });
  });
});
