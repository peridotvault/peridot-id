// Chain fee-policy service tests (ANT-730, ANT-743 pure percentage).
// DB-first percentage leg with frozen-table fallback; versioned rows that
// are never mutated; submit-time version gate (NFR-6/AC-11); public read
// view (AC-18). Minima removed: legacy `chain_min_fees` rows are inert,
// admin `minima` legs are accepted but ignored, quotes are pure percentage.
import { FeePolicyService } from "./fee-policy.service";
import { SOLANA_DEVNET_REFERENCE, SOLANA_NAMESPACE, SOLANA_TESTNET_REFERENCE } from "../common/chains";
import { protocolFeeOf } from "../common/solana-relay";

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    bps: 5000,
    active: true,
    fxSource: "CoinGecko USD/IDR",
    fxAsOf: new Date("2026-10-27T00:00:00Z"),
    createdAt: new Date("2026-10-27T00:00:00Z"),
    updatedAt: new Date("2026-10-27T00:00:00Z"),
    // Legacy pre-ANT-743 rows — the service must ignore these.
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

describe("FeePolicyService — DB-first reads (pure percentage)", () => {
  it("serves a zero minima leg even when legacy DB rows exist (ANT-743)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    // Solana: network 5_000 lamports → pure 50% = 2_500 (legacy 17_000 floor ignored).
    const sol = await service.minFeeFor(SOLANA_NAMESPACE, SOLANA_DEVNET_REFERENCE);
    expect(sol).toEqual({ minFee: 0n, version: 2, bps: 5000 });
    expect(protocolFeeOf(5_000n, sol.bps)).toBe(2_500n);
    // Base Sepolia: network 200 gwei → pure 50% = 100 gwei (legacy floor ignored).
    const base = await service.minFeeFor("eip155", "84532");
    expect(base.minFee).toBe(0n);
    expect(protocolFeeOf(200_000_000_000n, base.bps)).toBe(100_000_000_000n);
    // BSC: network 2.1M gwei-wei → pure 50% (legacy 2.3T floor ignored).
    const bsc = await service.minFeeFor("eip155", "97");
    expect(protocolFeeOf(2_100_000_000_000n, bsc.bps)).toBe(1_050_000_000_000n);
  });

  it("reads 0 for Monad/Arbitrum Sepolia (no floors anywhere)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    for (const ref of ["10143", "421614"]) {
      const m = await service.minFeeFor("eip155", ref);
      expect(m.minFee).toBe(0n);
      expect(protocolFeeOf(1_000_000_000n, m.bps)).toBe(500_000_000n);
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
    expect(sol).toEqual({ minFee: 0n, version: 2, bps: 5000 });
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

  it("exposes the public read view with empty minima (AC-18)", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    const view = await service.publicView();
    expect(view.version).toBe(2);
    expect(view.bps).toBe(5000);
    expect(view.minFee).toEqual({});
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
  it("accepts low legs with no floor gate (ANT-743: minima ignored, never persisted)", async () => {
    const { service, prisma, security } = setup([v1Row(), policyRow()]);
    const created = await service.createPolicy("admin@pid", {
      bps: 5000,
      minima: [{ namespace: "eip155", reference: "97", minFee: "1" }],
    });
    expect(created).toEqual({ version: 3, bps: 5000, active: false });
    const data = prisma.chainFeePolicy.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("minima");
    expect(security.log).toHaveBeenCalledWith("admin@pid", "admin.fee_policy.created", {
      version: 3,
      bps: 5000,
      chainCount: 0,
      ignoredMinima: 1,
    });
  });

  it("accepts a missing minima array (ANT-743)", async () => {
    const { service, prisma } = setup([v1Row(), policyRow()]);
    const created = await service.createPolicy("admin@pid", { bps: 5000 });
    expect(created).toEqual({ version: 3, bps: 5000, active: false });
    expect(prisma.chainFeePolicy.create).toHaveBeenCalled();
  });

  it("rejects bps above the protocol maximum", async () => {
    const { service } = setup([v1Row(), policyRow()]);
    await expect(
      service.createPolicy("admin@pid", { bps: 5001, minima: [] }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "FeeBpsOutOfRange" }) });
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
      chainCount: 0,
      ignoredMinima: 1,
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
