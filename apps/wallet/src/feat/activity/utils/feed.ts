import type { FiatDepositView, FiatLedgerEntry } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { ArrowDownLeft, ArrowUpRight, RefreshCw, Rocket } from "../../../shared/icons";
import { theme } from "../../../shared/theme";
import type { FiatItem, FiatKind, FiatLedgerItem, LedgerKind } from "../../../shared/fiat";

const LAMPORTS_PER_SOL = 1e9;

export type Tab = "all" | "onchain" | "idr";

export type AllItem =
  | { type: "chain"; createdAt: string; tx: WalletTransaction }
  | { type: "fiat"; createdAt: string; item: FiatItem }
  | { type: "ledger"; createdAt: string; item: FiatLedgerItem };

export function fiatKindOf(kind: string): FiatKind {
  if (kind === "deposit" || kind === "points_issue") return "deposit";
  if (kind === "transfer_internal") return "transfer";
  if (kind === "debit" || kind === "debit_cancel" || kind === "points_clawback") return "debit";
  if (kind === "fee" || kind === "points_fee") return "fee";
  return "withdraw";
}

export function fiatLabel(kind: FiatKind): string {
  switch (kind) {
    case "deposit": return "Deposit";
    case "transfer": return "Transfer";
    case "debit": return "Debit";
    case "fee": return "Service fee";
    default: return "Withdraw";
  }
}

export function ledgerKindOf(kind: string): LedgerKind {
  if (kind === "fiat_issue") return "deposit";
  if (kind === "fiat_adjust") return "adjust";
  return "transfer"; // fiat_transfer_in / fiat_transfer_out
}

export function ledgerLabel(kind: LedgerKind, incoming: boolean): string {
  if (kind === "deposit") return "Deposit";
  if (kind === "adjust") return "Adjustment";
  return incoming ? "Transfer in" : "Transfer out";
}

/** Pending deposits (DOKU intent rows not yet posted to the ledger). */
export function pendingDeposit(tx: FiatDepositView): boolean {
  return tx.kind === "deposit" && (tx.providerStatus === "created" || tx.providerStatus === "processing");
}

export function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "";
  const asset = t.asset === "SOL" ? "SOL" : t.asset;
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${asset}`;
}

export function meta(t: WalletTransaction): { label: string; icon: typeof ArrowUpRight; color: string } {
  switch (t.type) {
    case "DEPOSIT":
      return { label: "Receive", icon: ArrowDownLeft, color: theme.colors.success };
    case "WITHDRAW":
      return { label: "Send", icon: ArrowUpRight, color: theme.colors.foreground };
    case "ACTIVATION":
      return { label: "Activation", icon: Rocket, color: theme.colors.foreground };
    default:
      return { label: "Transaction", icon: RefreshCw, color: theme.colors.mutedForeground };
  }
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt > b.createdAt ? -1 : 1);

// Fee legs live in the DB (idempotency + audit) but never surface in the
// user's feed — the parent deposit/transfer already shows fee + net.
export function selectFiatItems(deposits: FiatDepositView[]): FiatItem[] {
  return deposits
    .filter((tx) => pendingDeposit(tx))
    .map((tx): FiatItem => ({ kind: "deposit", createdAt: tx.createdAt, tx }))
    .sort(byNewest);
}

export function selectLedgerItems(entries: FiatLedgerEntry[]): FiatLedgerItem[] {
  return entries
    .filter((tx) => tx.kind !== "fiat_fee")
    .map((tx): FiatLedgerItem => ({
      kind: ledgerKindOf(tx.kind),
      createdAt: tx.createdAt,
      tx,
    }))
    .sort(byNewest);
}

// IDR tab = pending DOKU deposit intents (not yet on the ledger) + the fiat
// ledger. Issued deposits appear only as fiat_issue rows.
export function selectVisible(
  items: WalletTransaction[],
  fiatItems: FiatItem[],
  ledgerItems: FiatLedgerItem[],
  tab: Tab,
): AllItem[] {
  const chainItems: AllItem[] = items.map((tx): AllItem => ({ type: "chain", createdAt: tx.createdAt, tx }));
  const idrAll: AllItem[] = [
    ...fiatItems.map((f): AllItem => ({ type: "fiat", createdAt: f.createdAt, item: f })),
    ...ledgerItems.map((c): AllItem => ({ type: "ledger", createdAt: c.createdAt, item: c })),
  ].sort(byNewest);
  if (tab === "onchain") return chainItems;
  if (tab === "idr") return idrAll;
  return [...chainItems, ...idrAll].sort(byNewest);
}
