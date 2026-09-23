// DOKU Sub-Account V2 client (1 PID → 1 Sub-Account). Peridot is
// identity/orchestration; DOKU is the authoritative ledger. No credentials
// touch this client.

import type { ApiError } from "@peridotvault/pid-types";
import type {
  CheckoutDepositView,
  DepositChannelView,
  FeePolicyView,
  SubAccountView,
  SubBalanceView,
  SubHistoryItem,
  SubTransferInquiryView,
  SubTxView,
} from "@peridotvault/pid-payments";

export type { CheckoutDepositView, DepositChannelView, FeePolicyView, SubAccountView, SubBalanceView, SubHistoryItem, SubTransferInquiryView, SubTxView };

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | ApiError }>;
}

function unwrap<T>(res: { ok: boolean; data: T | ApiError }, fallback: string): T {
  if (!res.ok || "statusCode" in (res.data as object)) {
    const msg = (res.data as ApiError)?.message ?? fallback;
    throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
  }
  return res.data as T;
}

const BASE = "/v1/fiat/sub-accounts";

/** Bank/e-wallet payouts deferred — internal transfers only for now. */
export type SacTransferType = "DOKU_SUB_ACCOUNT";

export class PeridotFiat {
  constructor(private readonly api: ApiLike) {}

  /** Register (or resume) the caller's Sub-Account. Name + email only. */
  async createAccount(input: { name: string; email: string }): Promise<SubAccountView> {
    return unwrap(await this.api.post<SubAccountView>(`${BASE}/accounts`, input), "Account creation failed");
  }

  async account(): Promise<SubAccountView> {
    return unwrap(await this.api.get<SubAccountView>(`${BASE}/accounts/me`), "Account not found");
  }

  /** Static BRI VA + IDR account for deposits. */
  async depositVa(): Promise<{ vaNumber: string | null; accountNo: string | null; profileId: string }> {
    return unwrap(await this.api.get<{ vaNumber: string | null; accountNo: string | null; profileId: string }>(`${BASE}/deposit-va`), "Failed to load deposit info");
  }

  /** Bank-agnostic money-in channels (Checkout groups + static BRI VA). */
  async depositChannels(): Promise<DepositChannelView[]> {
    return unwrap(await this.api.get<DepositChannelView[]>(`${BASE}/deposit-channels`), "Failed to load deposit channels");
  }

  /**
   * Create a Checkout deposit intent: DOKU-hosted page (all banks, QRIS,
   * e-money, cards) routed to the caller's sub-account. netAmountIdr is
   * the NET credited to the user (minimum Rp100.000); fee/gross-payable
   * quote returned upfront.
   */
  async checkoutDeposit(netAmountIdr: string): Promise<CheckoutDepositView> {
    return unwrap(await this.api.post<CheckoutDepositView>(`${BASE}/deposits/checkout`, { netAmountIdr }), "Checkout deposit failed");
  }

  /** Live balance from DOKU (authoritative). */
  async balance(): Promise<SubBalanceView> {
    return unwrap(await this.api.get<SubBalanceView>(`${BASE}/balance`), "Failed to load balance");
  }

  /** Authoritative history from DOKU. */
  async history(q: { accountNo?: string; fromDateTime: string; toDateTime: string; pageSize?: string; pageNumber?: string }): Promise<{ items: SubHistoryItem[] }> {
    const params = new URLSearchParams({ fromDateTime: q.fromDateTime, toDateTime: q.toDateTime });
    if (q.accountNo) params.set("accountNo", q.accountNo);
    if (q.pageSize) params.set("pageSize", q.pageSize);
    if (q.pageNumber) params.set("pageNumber", q.pageNumber);
    return unwrap(await this.api.get<{ items: SubHistoryItem[] }>(`${BASE}/transactions?${params}`), "Failed to load history");
  }

  /** Local transaction references (not a balance). */
  async ledger(): Promise<SubTxView[]> {
    return unwrap(await this.api.get<SubTxView[]>(`${BASE}/ledger`), "Failed to load ledger");
  }

  async feePolicy(): Promise<FeePolicyView> {
    return unwrap(await this.api.get<FeePolicyView>(`${BASE}/fee-policy`), "Failed to load fee policy");
  }

  /** Internal transfer step 1: POINT P2P inquiry only (moves no money).
   *  The recipient is addressed by PID; amounts are gross points. */
  async transferInquiry(input: {
    type: SacTransferType;
    amountIdr: string;
    beneficiaryPid: string;
    remark?: string;
  }): Promise<SubTransferInquiryView> {
    return unwrap(await this.api.post<SubTransferInquiryView>(`${BASE}/transfers/inquiry`, input), "Account validation failed");
  }

  /** Transfer step 2: executes the transfer bound to the inquiry. */
  async transferConfirm(id: string, input: { beneficiaryAccountName: string; expectedName?: string }): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/transfers/${id}/confirm`, input), "Transfer failed");
  }

  async retryTransfer(id: string): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/transfers/${id}/retry`), "Retry failed");
  }

  /** Reconcile a created/processing row via transactions-status. */
  async syncTransaction(id: string): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/transactions/${id}/sync`), "Sync failed");
  }

  // NOTE: settleFee was removed. DOKU settles NET → user sub-account +
  // FEE → Treasury natively; the API never moves fee money.

  /** Reconcile local rows against DOKU history over a window. */
  async reconcile(fromDateTime: string, toDateTime: string): Promise<{
    matched: number; backfilled: number; unparseable: number; truncated: boolean;
    missingProvider: string[]; issued: number; pendingIssuance: string[];
    pgObservedIdr: string; backing: unknown;
    drift: { liveIdr: string; cachedIdr: string | null; drift: boolean; checkedAt: string };
  }> {
    return unwrap(
      await this.api.post<{
        matched: number; backfilled: number; unparseable: number; truncated: boolean;
        missingProvider: string[]; issued: number; pendingIssuance: string[];
        pgObservedIdr: string; backing: unknown;
        drift: { liveIdr: string; cachedIdr: string | null; drift: boolean; checkedAt: string };
      }>(`${BASE}/reconcile`, { fromDateTime, toDateTime }),
      "Reconciliation failed",
    );
  }

  /** Live-vs-cached balance drift check (live wins, cache refreshes). */
  async drift(): Promise<{ liveIdr: string; cachedIdr: string | null; drift: boolean; checkedAt: string }> {
    return unwrap(await this.api.get<{ liveIdr: string; cachedIdr: string | null; drift: boolean; checkedAt: string }>(`${BASE}/drift`), "Drift check failed");
  }

  /** Cancel a created (not yet executed) transaction. */
  async cancelTransaction(id: string): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/transactions/${id}/cancel`), "Cancel failed");
  }

  /** Programmatic deduction from the sub-account (fee / purchase). */
  async debit(amountIdr: string, description?: string): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/debits`, { amountIdr, description }), "Debit failed");
  }

  async debitCancel(id: string, refundAmountIdr: string, reason?: string): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/debits/${id}/cancel`, { refundAmountIdr, reason }), "Debit cancel failed");
  }

  /** Admin: sweep outstanding issuance + backing report (cron-driven). */
  async adminSweep(input: { take?: number; skip?: number }): Promise<unknown> {
    return unwrap(await this.api.post<unknown>(`${BASE}/admin/sweep`, input), "Sweep failed");
  }

  /** Admin: backfill makeup points for settled deposits missing issuance. */
  async adminBackfill(input: { pid?: string; take?: number }): Promise<unknown> {
    return unwrap(await this.api.post<unknown>(`${BASE}/admin/backfill`, input), "Backfill failed");
  }

  /** Admin: claw back issued points after a failed/charged-back payment. */
  async adminClawback(input: { transactionId: string; amountIdr: string; reason?: string }): Promise<SubTxView> {
    return unwrap(await this.api.post<SubTxView>(`${BASE}/admin/clawback`, input), "Clawback failed");
  }

  /** Admin: reconstruct historical recipient mirrors (authoritative-or-review). */
  async adminBackfillMirrors(input: { take?: number }): Promise<unknown> {
    return unwrap(await this.api.post<unknown>(`${BASE}/admin/backfill-mirrors`, input), "Mirror backfill failed");
  }

  /** Admin: immutable journal export + replay verdict for one PID. */
  async adminJournal(pid: string): Promise<unknown> {
    return unwrap(await this.api.get<unknown>(`${BASE}/admin/journal/${pid}`), "Journal export failed");
  }

  /** Admin: platform-wide replay projection (bounded). */
  async adminReplay(): Promise<unknown> {
    return unwrap(await this.api.get<unknown>(`${BASE}/admin/replay`), "Replay failed");
  }
}
