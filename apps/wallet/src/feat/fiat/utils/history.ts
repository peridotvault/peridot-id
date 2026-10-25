import type { FiatDepositView, FiatLedgerEntry } from "@peridotvault/pid-sdk-js";
import type { FiatItem, FiatKind, FiatLedgerItem, LedgerKind } from "../../../shared/data/fiat";

// Kind vocabularies as sets: new API kinds extend the set, not the branch.
const DEPOSIT_KINDS = new Set(["deposit", "points_issue"]);
const TRANSFER_KINDS = new Set(["transfer_internal"]);
const DEBIT_KINDS = new Set(["debit", "debit_cancel", "points_clawback"]);
const FEE_KINDS = new Set(["fee", "points_fee"]);

export function fiatKindOf(kind: string): FiatKind {
  if (DEPOSIT_KINDS.has(kind)) return "deposit";
  if (TRANSFER_KINDS.has(kind)) return "transfer";
  if (DEBIT_KINDS.has(kind)) return "debit";
  if (FEE_KINDS.has(kind)) return "fee";
  return "withdraw";
}

const FIAT_LABELS: Record<FiatKind, string> = {
  deposit: "Deposit",
  transfer: "Transfer",
  debit: "Debit",
  fee: "Service fee",
  withdraw: "Withdraw",
};

export function fiatLabel(kind: FiatKind): string {
  return FIAT_LABELS[kind];
}

const LEDGER_KIND: Record<string, LedgerKind> = {
  fiat_issue: "deposit",
  fiat_adjust: "adjust",
};

export function ledgerKindOf(kind: string): LedgerKind {
  return LEDGER_KIND[kind] ?? "transfer"; // fiat_transfer_in / fiat_transfer_out
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
