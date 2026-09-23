// Shared Sub-Account view types (DOKU Sub-Account V2). DOKU is the ledger —
// these are API response shapes, never a local balance.

export type SubAccountStatus = "creating" | "active" | "suspended";

export interface SubAccountView {
  status: SubAccountStatus;
  currency: "IDR";
  profileId: string | null;
  /** IDR cash account number (fiat backing, admin/debug). */
  accountNo: string | null;
  /** POINT account number (spendable Saldo ledger). */
  pointAccountNo: string | null;
  /** Static BRI VA for deposits (when DOKU returns it). */
  vaNumber: string | null;
  phoneNo: string | null;
  email: string | null;
  lastBalanceIdr: string | null;
  lastBalanceAt: string | null;
}

export interface SubBalanceView {
  /** Spendable Saldo — live DOKU Unified Ledger POINT balance (1:1 IDR peg). */
  pointsAvailableIdr: string;
  pointsReservedIdr: string;
  /** Fiat backing (admin/debug — never the spendable number). */
  availableIdr: string;
  reservedIdr: string;
  pendingIdr: string;
  currency: "IDR";
  cachedAt: string;
}

export interface SubTxView {
  id: string;
  kind: string;
  providerRef: string;
  providerStatus: string;
  /** Gross movement amount, whole IDR. Checkout deposits: what the customer
   *  paid (net + fee). Internal transfers: the requested amount, GROSS-in
   *  (beneficiary receives gross − fee). */
  grossIdr: string;
  /** Platform service fee quote, whole IDR (snapshotted at intent time;
   *  legacy `kind = fee` rows remain for history only). */
  feeIdr: string | null;
  /** Net effect on the user, whole IDR (gross − fee). */
  netIdr: string | null;
  /** DOKU-hosted payment page for unpaid Checkout deposits (null otherwise).
   *  Cached from the payment-creation response — re-openable anytime. */
  paymentUrl: string | null;
  /** Legacy fee-leg status (`{ref}-FEE` row), read-only: settled |
   *  processing | failed | null (no leg). */
  feeStatus: string | null;
  currency: "IDR";
  createdAt: string;
}

export interface SubTransferInquiryView {
  id: string;
  providerRef: string;
  transferType: string;
  accountNumber: string;
  /** Recipient identity (server-resolved to the POINT account). */
  beneficiaryPid?: string;
  accountName: string | null;
  inquiryReferenceNo: string;
  /** Gross requested, whole IDR. */
  grossIdr: string;
  /** Quoted platform fee under the active policy, whole IDR. */
  feeIdr: string;
  /** Amount the beneficiary will receive (gross − fee), whole IDR. */
  netIdr: string;
  feePolicyVersion: number;
}

export interface SubHistoryItem {
  mutationType?: string;
  transactionType?: string;
  amount?: string;
  amountIdr?: string;
  currency?: string;
  status?: string;
  dateTime?: string;
  remark?: string;
  partnerReferenceNo?: string;
  referenceNo?: string;
  channel?: string;
}

export interface FeePolicyView {
  version: number;
  percentBps: number;
  minIdr: string;
  maxIdr: string;
  active: boolean;
}

export interface CheckoutDepositView {
  id: string;
  providerRef: string;
  paymentUrl: string;
  tokenId: string;
  expiredDate: string | null;
  grossIdr: string;
  feeIdr: string;
  netIdr: string;
  feePolicyVersion: number;
  providerStatus: string;
  createdAt: string;
}

/** Bank-agnostic money-in channels (verified compatibility table). */
export interface DepositChannelView {
  id: string;
  label: string;
  /** checkout = DOKU-hosted page (all active channels); bri_va = static VA. */
  via: "checkout" | "bri_va";
}
