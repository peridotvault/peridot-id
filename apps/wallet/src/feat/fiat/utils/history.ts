import type { FiatDepositView, FiatLedgerEntry } from "@peridotvault/pid-sdk-js";
import type { FiatItem, FiatKind, FiatLedgerItem, LedgerKind } from "../../../shared/data/fiat";

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
