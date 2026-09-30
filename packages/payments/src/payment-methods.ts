// DOKU Checkout payment methods + the payment-gateway fee model. The catalog
// maps DOKU `payment_method_types` codes to a display label and a coarse
// category; per-method fees differ (VA / e-wallet / card / QRIS), so the fee is
// resolved per method and falls back to its category, then "*".
//
// DOKU Checkout exposes NO real-time per-transaction fee API: fees are per
// method, configured in the DOKU dashboard, and deducted at settlement. So the
// authoritative path is the internal rate config; a DOKU fee API hook exists on
// the client (DokuCheckoutClient.transactionFee) and returns null today.

export type PaymentMethodCategory = "VIRTUAL_ACCOUNT" | "EWALLET" | "CARD" | "QRIS" | "OTHER";

/** Default rate key used when neither the method nor its category has a rate. */
export const DEFAULT_GATEWAY_RATE_KEY = "*";

export interface PaymentMethodInfo {
  code: string;
  label: string;
  category: PaymentMethodCategory;
}

/** DOKU Checkout `payment_method_types` values (documented, active channels). */
export const PAYMENT_METHODS: readonly PaymentMethodInfo[] = [
  { code: "VIRTUAL_ACCOUNT_BCA", label: "BCA Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BRI", label: "BRI Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BNI", label: "BNI Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BANK_MANDIRI", label: "Mandiri Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BANK_PERMATA", label: "Permata Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BANK_CIMB", label: "CIMB Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BANK_DANAMON", label: "Danamon Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BANK_SYARIAH_MANDIRI", label: "BSI Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_DOKU", label: "DOKU Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BTN", label: "BTN Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BNC", label: "BNC Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_BJB", label: "BJB Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "VIRTUAL_ACCOUNT_SINARMAS", label: "Sinarmas Virtual Account", category: "VIRTUAL_ACCOUNT" },
  { code: "EMONEY_OVO", label: "OVO", category: "EWALLET" },
  { code: "EMONEY_DANA", label: "DANA", category: "EWALLET" },
  { code: "EMONEY_SHOPEE_PAY", label: "ShopeePay", category: "EWALLET" },
  { code: "EMONEY_LINKAJA", label: "LinkAja", category: "EWALLET" },
  { code: "EMONEY_DOKU", label: "DOKU e-Wallet", category: "EWALLET" },
  { code: "CREDIT_CARD", label: "Credit / Debit Card", category: "CARD" },
  { code: "GOOGLE_PAY", label: "Google Pay", category: "CARD" },
  { code: "QRIS", label: "QRIS", category: "QRIS" },
] as const;

const BY_CODE = new Map(PAYMENT_METHODS.map((m) => [m.code, m]));

/** Category order + labels (the coarse picker users see). */
export const PAYMENT_CATEGORIES: readonly PaymentMethodCategory[] = ["VIRTUAL_ACCOUNT", "EWALLET", "CARD", "QRIS", "OTHER"];

const CATEGORY_LABELS: Record<PaymentMethodCategory, string> = {
  VIRTUAL_ACCOUNT: "Virtual Account",
  EWALLET: "e-Wallet",
  CARD: "Card",
  QRIS: "QRIS",
  OTHER: "Other",
};

export function categoryLabel(category: PaymentMethodCategory): string {
  return CATEGORY_LABELS[category];
}

/** DOKU `payment_method_types` values in a category (what to lock at DOKU). */
export function codesForCategory(category: string): string[] {
  const key = String(category ?? "").trim().toUpperCase();
  return PAYMENT_METHODS.filter((m) => m.category === key).map((m) => m.code);
}

/** True when the token is a category key (not a specific method code). */
export function isPaymentMethodCategory(token: string): boolean {
  return (PAYMENT_CATEGORIES as readonly string[]).includes(String(token ?? "").trim().toUpperCase());
}

/** Catalog entry for a code, or null when unknown. */
export function paymentMethod(code: string): PaymentMethodInfo | null {
  return BY_CODE.get(code) ?? null;
}

/** Category for a code; unknown codes fall to "OTHER". */
export function paymentMethodCategory(code: string): PaymentMethodCategory {
  return BY_CODE.get(code)?.category ?? "OTHER";
}

/** A gateway fee rate: percent + flat, clamped to [minIdr, maxIdr] (0 = unbounded). */
export interface GatewayFeeRate {
  percentBps: number;
  flatIdr: bigint;
  minIdr: bigint;
  maxIdr: bigint;
}

/** Gateway fee = clamp(round-half-up(amount*percentBps/10_000) + flat). */
export function calcGatewayFee(amountIdr: bigint, rate: GatewayFeeRate): bigint {
  if (amountIdr < 0n) return 0n;
  let fee = (amountIdr * BigInt(rate.percentBps) + 5_000n) / 10_000n + rate.flatIdr;
  if (fee < 0n) fee = 0n;
  if (rate.minIdr > 0n && fee < rate.minIdr) return rate.minIdr;
  if (rate.maxIdr > 0n && fee > rate.maxIdr) return rate.maxIdr;
  return fee;
}

// ponytail: self-check — `node dist/payment-methods.js` fails loudly if broken.
if (require.main === module) {
  const assert = require("node:assert");
  assert.ok(PAYMENT_METHODS.length === 21, "catalog size");
  assert.strictEqual(paymentMethod("EMONEY_OVO")?.category, "EWALLET", "known category");
  assert.strictEqual(paymentMethodCategory("NOPE"), "OTHER", "unknown -> OTHER");
  assert.strictEqual(paymentMethodCategory("VIRTUAL_ACCOUNT_BCA"), "VIRTUAL_ACCOUNT", "VA category");
  assert.strictEqual(categoryLabel("EWALLET"), "e-Wallet", "category label");
  assert.ok(codesForCategory("EWALLET").includes("EMONEY_OVO"), "category channels");
  assert.ok(isPaymentMethodCategory("QRIS"), "category token");
  assert.ok(!isPaymentMethodCategory("EMONEY_OVO"), "code is not a category");
  const rate = { percentBps: 200, flatIdr: 0n, minIdr: 0n, maxIdr: 0n };
  assert.strictEqual(calcGatewayFee(100_000n, rate), 2_000n, "2% of 100k");
  assert.strictEqual(calcGatewayFee(100_000n, { ...rate, minIdr: 2_500n }), 2_500n, "floor");
  assert.strictEqual(calcGatewayFee(1_000_000n, { ...rate, maxIdr: 5_000n }), 5_000n, "cap");
  assert.strictEqual(calcGatewayFee(10_000n, { percentBps: 0, flatIdr: 4_000n, minIdr: 0n, maxIdr: 0n }), 4_000n, "flat");
  console.log("pid-payments payment-methods self-check OK");
}
