// Shared fiat presentation types + labels. Needed by both the activity feed
// (activity domain) and the fiat detail screens (fiat domain) — so they live
// in shared/, not in any single screen (feat/ may never import another feat,
// screens/ may never import another screen).
import type { DepositQuoteView, FiatDepositView, FiatLedgerEntry, PaymentMethodQuote } from "@peridotvault/pid-sdk-js";
import { sumTransferFee } from "@peridotvault/pid-sdk-js";

export type FiatKind = "deposit" | "withdraw" | "transfer" | "debit" | "fee";

/** Ledger-backed fiat row. DOKU is the ledger; this is the reference log. */
export type FiatItem = { kind: FiatKind; createdAt: string; tx: FiatDepositView };

/** A fiat ledger entry row. */
export type LedgerKind = "deposit" | "transfer" | "adjust";
export type FiatLedgerItem = { kind: LedgerKind; createdAt: string; tx: FiatLedgerEntry };

/** Friendly status text — provider enums (settled/processing/...) never reach the user. */
export function fiatStatusLabel(kind: FiatKind, status: string): string {
  const incoming = kind === "deposit";
  switch (status) {
    case "success":
    case "settled":
      return incoming ? "Payment received" : "Completed";
    case "created":
    case "processing":
      return incoming ? "Waiting for payment" : "Processing";
    case "expired":
      return incoming ? "Payment expired" : "Expired";
    case "failed":
      return incoming ? "Payment failed" : "Failed";
    case "cancelled":
      return "Cancelled";
    case "refunded":
      return "Refunded";
    default:
      return "Pending";
  }
}

export function ledgerStatusLabel(status: string): string {
  switch (status) {
    case "posted":
      return "Completed";
    case "created":
      return "Pending";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending";
  }
}

/** Sum two whole-IDR strings (PPN folded into the shown fee lines). */
export function sumIdr(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

/** Whole-IDR units → display ("100000" → "Rp100.000"). */
export function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

/** One combined fee line: quoted transfer fee, else PeridotID + gateway sum. */
export function transferFeeOf(quote: DepositQuoteView): string {
  return quote.transferFeeIdr ?? sumTransferFee(quote);
}

/**
 * The fee line for the SELECTED payment method: PeridotID (fee+PPN) + the
 * method's DOKU gateway fee+PPN. The checkout quote is fetched without a method
 * (the user picks client-side), so its own `transferFeeIdr` excludes the gateway
 * fee — derive the fee from the selected method's total instead:
 * total = net + PeridotID fee+PPN + appFee + gateway fee+PPN.
 */
export function selectedTransferFee(quote: DepositQuoteView, method: PaymentMethodQuote | null): string {
  const total = BigInt(method?.totalIdr ?? quote.totalIdr);
  const fee = total - BigInt(quote.netIdr) - BigInt(quote.appFeeIdr);
  return (fee < 0n ? 0n : fee).toString();
}

/** Keep the previous payment method if still offered, else the first one. */
export function pickMethod(prev: string | null, methods: { key: string }[]): string | null {
  return prev && methods.some((m) => m.key === prev) ? prev : methods[0]?.key ?? null;
}
