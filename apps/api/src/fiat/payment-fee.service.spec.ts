import { ConfigService } from "@nestjs/config";
import type { DokuCheckoutClient } from "@peridotvault/pid-payments";
import { PaymentFeeService } from "./payment-fee.service";

function configStub(store: Record<string, string> = {}) {
  return { get: (k: string, d?: string) => store[k] ?? d ?? "" } as unknown as ConfigService;
}

interface RateRow {
  methodKey: string;
  percentBps: number;
  flatIdr: bigint;
  minIdr: bigint;
  maxIdr: bigint;
  enabled: boolean;
}

function setup(rows: RateRow[] = [], store: Record<string, string> = {}, dokuFee: bigint | null = null, dokuTaxBps = 1100) {
  const prisma: any = {
    paymentGatewayFeeRate: {
      findMany: jest.fn(async (args: any) => {
        const keys: string[] = args?.where?.methodKey?.in ?? [];
        return rows.filter((r) => keys.includes(r.methodKey));
      }),
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args: any) => ({ id: "r1", ...args.create, ...args.update })),
    },
    fiatTaxSetting: {
      findUnique: jest.fn(async () => ({ id: 1, dokuTaxBps })),
      upsert: jest.fn(async (args: any) => ({ id: 1, ...args.create, ...args.update })),
    },
  };
  const checkout = { transactionFee: jest.fn(async () => dokuFee) } as unknown as jest.Mocked<DokuCheckoutClient>;
  const service = new PaymentFeeService(prisma as never, configStub(store), checkout);
  return { service, prisma, checkout };
}

const row = (methodKey: string, percentBps: number, extra: Partial<RateRow> = {}): RateRow => ({
  methodKey, percentBps, flatIdr: 0n, minIdr: 0n, maxIdr: 0n, enabled: true, ...extra,
});

describe("PaymentFeeService", () => {
  it("resolves exact method code over category and default", async () => {
    const { service } = setup([row("VIRTUAL_ACCOUNT_BCA", 100), row("VIRTUAL_ACCOUNT", 200), row("*", 300)]);
    const q = await service.gatewayFee("VIRTUAL_ACCOUNT_BCA", 100_000n);
    expect(q).toMatchObject({ feeIdr: 1_000n, enabled: true, source: "config", rateKey: "VIRTUAL_ACCOUNT_BCA" });
  });

  it("falls back to the category rate when the exact code has none", async () => {
    const { service } = setup([row("EWALLET", 250)]);
    const q = await service.gatewayFee("EMONEY_DANA", 100_000n);
    expect(q).toMatchObject({ feeIdr: 2_500n, rateKey: "EWALLET" });
  });

  it("falls back to the '*' default, then disabled+zero when nothing is configured", async () => {
    const withDefault = setup([row("*", 300)]);
    expect(await withDefault.service.gatewayFee("QRIS", 100_000n)).toMatchObject({ feeIdr: 3_000n, enabled: true });
    const none = setup([]);
    expect(await none.service.gatewayFee("QRIS", 100_000n)).toMatchObject({ feeIdr: 0n, enabled: false, rateKey: "unset" });
  });

  it("a disabled row shadows the '*' fallback (explicit off, not a fall-through)", async () => {
    const { service } = setup([row("VIRTUAL_ACCOUNT", 250, { enabled: false }), row("*", 300)]);
    const q = await service.gatewayFee("VIRTUAL_ACCOUNT", 100_000n);
    expect(q).toMatchObject({ feeIdr: 0n, enabled: false, rateKey: "VIRTUAL_ACCOUNT" });
  });

  it("a category token resolves against its own row, never OTHER", async () => {
    const { service } = setup([row("VIRTUAL_ACCOUNT", 150), row("OTHER", 999)]);
    const q = await service.gatewayFee("VIRTUAL_ACCOUNT", 100_000n);
    expect(q.feeIdr).toBe(1_500n);
  });

  it("uses the live DOKU fee when the API is enabled and returns one", async () => {
    const { service, checkout } = setup([], { PID_DOKU_FEE_API_ENABLED: "true" }, 4_200n);
    const q = await service.gatewayFee("EMONEY_OVO", 100_000n);
    expect(checkout.transactionFee).toHaveBeenCalledWith("EMONEY_OVO", 100_000n);
    expect(q).toMatchObject({ feeIdr: 4_200n, enabled: true, source: "doku", rateKey: "doku-api" });
  });

  it("falls back to config when the DOKU fee API is unavailable", async () => {
    const { service } = setup([row("CARD", 290)], { PID_DOKU_FEE_API_ENABLED: "true" }, null);
    const q = await service.gatewayFee("CREDIT_CARD", 100_000n);
    expect(q).toMatchObject({ feeIdr: 2_900n, source: "config", rateKey: "CARD" });
  });

  it("methodsFor returns only enabled categories", async () => {
    const { service } = setup([row("VIRTUAL_ACCOUNT", 400), row("EWALLET", 100, { enabled: false })]);
    const options = await service.methodsFor(100_000n);
    expect(options.map((o) => o.key)).toEqual(["VIRTUAL_ACCOUNT"]);
    expect(options[0]).toMatchObject({ label: "Virtual Account", enabled: true, gatewayFeeIdr: "4000" });
  });

  it("methodsFor is empty when nothing is enabled (default off)", async () => {
    const { service } = setup([]);
    expect(await service.methodsFor(100_000n)).toEqual([]);
  });

  it("applies the DOKU-wide PPN to the gateway fee", async () => {
    const { service } = setup([row("VIRTUAL_ACCOUNT", 250)]); // 2.5% of 100k = 2500
    const q = await service.gatewayFee("VIRTUAL_ACCOUNT", 100_000n);
    expect(q.feeIdr).toBe(2_500n);
    expect(q.taxIdr).toBe(275n); // 11% of 2500
    const zero = setup([row("VIRTUAL_ACCOUNT", 250)], {}, null, 0);
    expect((await zero.service.gatewayFee("VIRTUAL_ACCOUNT", 100_000n)).taxIdr).toBe(0n);
  });

  it("getDokuTax / setDokuTax round-trips the singleton", async () => {
    const { service, prisma } = setup([], {}, null, 1100);
    expect(await service.getDokuTax()).toEqual({ taxBps: 1100 });
    const saved = await service.setDokuTax(500);
    expect(prisma.fiatTaxSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
    expect(saved).toEqual({ taxBps: 500 });
  });

  it("upsertRate stores the key uppercased", async () => {
    const { service, prisma } = setup();
    await service.upsertRate("virtual_account_bca", { percentBps: 100, flatIdr: "0", minIdr: "0", maxIdr: "0", enabled: true });
    expect(prisma.paymentGatewayFeeRate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { methodKey: "VIRTUAL_ACCOUNT_BCA" } }),
    );
  });
});
