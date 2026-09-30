import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  calcGatewayFee,
  calcTaxAmount,
  categoryLabel,
  codesForCategory,
  DEFAULT_GATEWAY_RATE_KEY,
  isPaymentMethodCategory,
  PAYMENT_CATEGORIES,
  paymentMethodCategory,
  type GatewayFeeRate,
  type DokuCheckoutClient,
} from "@peridotvault/pid-payments";
import { PrismaService } from "../prisma/prisma.service";
import { CHECKOUT_CLIENT } from "./checkout-client.token";

/** Rate resolution order: exact method code → category → "*". */
function rateKeys(methodKey: string): string[] {
  const key = (methodKey || "").trim().toUpperCase();
  if (!key) return [DEFAULT_GATEWAY_RATE_KEY];
  // A category token resolves against its own row, then "*" — never "OTHER".
  if (isPaymentMethodCategory(key)) return [key, DEFAULT_GATEWAY_RATE_KEY];
  return [key, paymentMethodCategory(key), DEFAULT_GATEWAY_RATE_KEY];
}

export interface GatewayFeeQuote {
  feeIdr: bigint;
  /** DOKU PPN on the fee (folded into the wallet's "Fee Transfer" line). */
  taxIdr: bigint;
  /** true = charge + show the fee line; false = hide it (no charge). */
  enabled: boolean;
  /** "doku" = live DOKU API; "config" = internal rate table. */
  source: "doku" | "config";
  rateKey: string;
}

/**
 * Payment-gateway (DOKU) fee for top-ups. DOKU fees differ per payment method
 * (VA / e-wallet / card / QRIS) and Checkout exposes no real-time fee API, so
 * the authoritative source is the admin-editable `payment_gateway_fee_rates`
 * table; a DOKU API hook is tried first when enabled. See
 * packages/payments/src/payment-methods.ts.
 */
@Injectable()
export class PaymentFeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CHECKOUT_CLIENT) private readonly checkout: DokuCheckoutClient,
  ) {}

  /** True only when ops opted into the (currently non-existent) DOKU fee API. */
  private dokuFeeApiEnabled(): boolean {
    return this.config.get<string>("PID_DOKU_FEE_API_ENABLED", "false") === "true";
  }

  /** DOKU-wide PPN (VAT) rate in basis points (singleton; default 11%). */
  private async dokuTaxBps(): Promise<number> {
    const row = await this.prisma.fiatTaxSetting.findUnique({ where: { id: 1 } }).catch(() => null);
    return row?.dokuTaxBps ?? 1100;
  }

  /** Gateway fee for one method code and amount. Never throws. */
  async gatewayFee(methodCode: string, amountIdr: bigint): Promise<GatewayFeeQuote> {
    const taxBps = await this.dokuTaxBps();
    if (this.dokuFeeApiEnabled()) {
      try {
        const live = await this.checkout.transactionFee(methodCode, amountIdr);
        if (live !== null && live >= 0n) {
          return { feeIdr: live, taxIdr: calcTaxAmount(live, taxBps), enabled: true, source: "doku", rateKey: "doku-api" };
        }
      } catch {
        // fall through to config — never block a quote on the fee API
      }
    }
    const resolved = await this.resolveRate(methodCode);
    if (!resolved) return { feeIdr: 0n, taxIdr: 0n, enabled: false, source: "config", rateKey: "unset" };
    const { row, enabled } = resolved;
    if (!enabled) return { feeIdr: 0n, taxIdr: 0n, enabled: false, source: "config", rateKey: row.methodKey };
    const rate: GatewayFeeRate = { percentBps: row.percentBps, flatIdr: row.flatIdr, minIdr: row.minIdr, maxIdr: row.maxIdr };
    const fee = calcGatewayFee(amountIdr, rate);
    return { feeIdr: fee, taxIdr: calcTaxAmount(fee, taxBps), enabled: true, source: "config", rateKey: row.methodKey };
  }

  /**
   * First rate row in resolution order (exact → category → "*"). Disabled rows
   * are found too: the first key that has a row wins, so an explicitly disabled
   * method shadows the "*" fallback (a real off switch, not a fall-through).
   */
  private async resolveRate(methodCode: string): Promise<{ row: { methodKey: string; percentBps: number; flatIdr: bigint; minIdr: bigint; maxIdr: bigint; enabled: boolean }; enabled: boolean } | null> {
    const keys = rateKeys(methodCode);
    const rows = await this.prisma.paymentGatewayFeeRate
      .findMany({ where: { methodKey: { in: keys } } })
      .catch(() => []);
    const byKey = new Map(rows.map((r) => [r.methodKey, r]));
    for (const key of keys) {
      const row = byKey.get(key);
      if (row) return { row, enabled: row.enabled };
    }
    return null;
  }

  /**
   * Enabled payment categories only, with their gateway fee (quote UI). A
   * category with no enabled row is absent — the wallet hides it entirely.
   * `key` is what the user picks and what the checkout call passes back.
   */
  async methodsFor(amountIdr: bigint): Promise<
    Array<{ key: string; label: string; category: string; enabled: boolean; gatewayFeeIdr: string; gatewayTaxIdr: string; rateKey: string; source: "doku" | "config" }>
  > {
    const options = await Promise.all(
      // Only categories with real DOKU channels are pickable ("OTHER" is a
      // rate-fallback bucket, not a payment option).
      PAYMENT_CATEGORIES.filter((c) => codesForCategory(c).length > 0).map(async (category) => {
        const q = await this.gatewayFee(category, amountIdr);
        return {
          key: category,
          label: categoryLabel(category),
          category,
          enabled: q.enabled,
          gatewayFeeIdr: q.feeIdr.toString(),
          gatewayTaxIdr: q.taxIdr.toString(),
          rateKey: q.rateKey,
          source: q.source,
        };
      }),
    );
    return options.filter((o) => o.enabled);
  }

  // --- admin config ---

  /** The DOKU-wide PPN rate (singleton). */
  async getDokuTax(): Promise<{ taxBps: number }> {
    return { taxBps: await this.dokuTaxBps() };
  }

  /** Set the DOKU-wide PPN rate (singleton). */
  async setDokuTax(taxBps: number): Promise<{ taxBps: number }> {
    const row = await this.prisma.fiatTaxSetting.upsert({
      where: { id: 1 },
      create: { id: 1, dokuTaxBps: taxBps },
      update: { dokuTaxBps: taxBps },
    });
    return { taxBps: row.dokuTaxBps };
  }

  /**
   * The category catalog (always, so the admin can enumerate checkboxes),
   * merged with any stored non-category rows (specific codes / "*"). A category
   * with no stored row shows as disabled at 0.
   */
  async listRates() {
    const stored = await this.prisma.paymentGatewayFeeRate.findMany({ orderBy: { methodKey: "asc" } });
    const byKey = new Map(stored.map((r) => [r.methodKey, r]));
    const categories = PAYMENT_CATEGORIES.filter((c) => codesForCategory(c).length > 0).map((category) => {
      const r = byKey.get(category);
      byKey.delete(category);
      return {
        methodKey: category,
        label: categoryLabel(category),
        category: category as string | null,
        isCategory: true,
        percentBps: r?.percentBps ?? 0,
        flatIdr: (r?.flatIdr ?? 0n).toString(),
        minIdr: (r?.minIdr ?? 0n).toString(),
        maxIdr: (r?.maxIdr ?? 0n).toString(),
        enabled: r?.enabled ?? false,
        updatedAt: r?.updatedAt ?? null,
      };
    });
    const extras = [...byKey.values()].map((r) => ({
      methodKey: r.methodKey,
      label: r.methodKey,
      category: null as string | null,
      isCategory: false,
      percentBps: r.percentBps,
      flatIdr: r.flatIdr.toString(),
      minIdr: r.minIdr.toString(),
      maxIdr: r.maxIdr.toString(),
      enabled: r.enabled,
      updatedAt: r.updatedAt,
    }));
    return [...categories, ...extras];
  }

  /** Upsert one rate row (exact code, category, or "*"). */
  async upsertRate(
    methodKey: string,
    input: { percentBps: number; flatIdr: string; minIdr: string; maxIdr: string; enabled: boolean },
  ) {
    const key = (methodKey || "").trim().toUpperCase();
    const row = await this.prisma.paymentGatewayFeeRate.upsert({
      where: { methodKey: key },
      create: {
        methodKey: key,
        percentBps: input.percentBps,
        flatIdr: BigInt(input.flatIdr),
        minIdr: BigInt(input.minIdr),
        maxIdr: BigInt(input.maxIdr),
        enabled: input.enabled,
      },
      update: {
        percentBps: input.percentBps,
        flatIdr: BigInt(input.flatIdr),
        minIdr: BigInt(input.minIdr),
        maxIdr: BigInt(input.maxIdr),
        enabled: input.enabled,
      },
    });
    return {
      methodKey: row.methodKey,
      percentBps: row.percentBps,
      flatIdr: row.flatIdr.toString(),
      minIdr: row.minIdr.toString(),
      maxIdr: row.maxIdr.toString(),
      enabled: row.enabled,
    };
  }
}
