// Shared fiat-gateway types (fiat ledger only — no on-chain conversion yet).

export type FiatTopupStatus = "pending" | "paid" | "expired" | "failed";

export type FiatWithdrawStatus = "pending" | "settled" | "rejected";

export interface CreateTopupInput {
  /** Whole IDR, e.g. "10000" (= Rp10.000). Min 10000 enforced server-side. */
  amountIdr: string;
}

export interface TopupView {
  id: string;
  invoiceNumber: string;
  amountIdr: string;
  currency: "IDR";
  provider: string;
  status: FiatTopupStatus;
  paymentUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface WithdrawView {
  id: string;
  amountIdr: string;
  currency: "IDR";
  /** pending = awaiting manual settlement; settled/rejected set by an admin. */
  status: FiatWithdrawStatus;
  createdAt: string;
}

export interface FiatBalance {
  availableIdr: string;
  currency: "IDR";
}
