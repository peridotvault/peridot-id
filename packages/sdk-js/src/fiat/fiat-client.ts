// PeridotID fiat — one namespace for money. The spendable balance, statement
// and send/receive live on the internal fiat ledger; DOKU Checkout is
// money-in only (no Sub-Account). No credentials touch this client.

import type { ApiError } from "@peridotvault/pid-types";

/** Ledger balance (replayed server-side). */
export interface FiatBalanceView {
  balanceIdr: string;
  currency: "IDR";
  source: "fiat-ledger";
  replayErrors: string[];
}

/** One immutable ledger entry (a double-entry leg). */
export interface FiatLedgerEntry {
  id: string;
  /** fiat_issue | fiat_fee | fiat_transfer_in | fiat_transfer_out | fiat_adjust */
  kind: string;
  entryGroup: string;
  counterpartyPid: string | null;
  /** Leg amount; the sign comes from `direction`. */
  amountIdr: string;
  /** in | out */
  direction: string;
  /** created | posted | failed | cancelled */
  status: string;
  createdAt: string;
}

export interface FiatLedgerView {
  pid: string;
  balanceIdr: string;
  treasuryCreditedIdr: string;
  inFlight: string[];
  errors: string[];
  rows: FiatLedgerEntry[];
}

export interface FiatTransferInput {
  /** Gross amount to send (fee quoted server-side, net goes to recipient). */
  amountIdr: string;
  /** Recipient identity, e.g. live2dev@pid (resolved server-side). */
  beneficiaryPid: string;
  remark?: string;
  /** App context (model A): when set, this app's fee applies and stacks. */
  clientId?: string;
}

export interface FiatTransferInquiryView {
  id: string;
  entryGroup: string;
  grossIdr: string;
  /** Total fee (global PeridotID + app). */
  feeIdr: string;
  /** App portion of the fee (0 when no app context). */
  appFeeIdr?: string;
  netIdr: string;
  feePolicyVersion: number;
  beneficiaryPid: string;
}

/** A DOKU Checkout deposit intent (money-in). */
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

/** A deposit row's corroborated status (sync result). */
export interface FiatDepositView {
  id: string;
  kind: string;
  providerRef: string;
  providerStatus: string;
  grossIdr: string;
  feeIdr: string | null;
  netIdr: string | null;
  paymentUrl: string | null;
  currency: "IDR";
  createdAt: string;
}

export interface FeePolicyView {
  version: number;
  percentBps: number;
  minIdr: string;
  maxIdr: string;
  active: boolean;
}

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | ApiError }>;
  /** Present on PeridotClient: run a trust-critical action in the PeridotID popup. */
  popupRequest?<T>(action: string, payload?: unknown): Promise<T>;
  /** Present on PeridotClient: popup host origin, set in third-party mode only. */
  popupBaseUrl?: string;
}

function unwrap<T>(res: { ok: boolean; data: T | ApiError }, fallback: string): T {
  if (!res.ok || "statusCode" in (res.data as object)) {
    const msg = (res.data as ApiError)?.message ?? fallback;
    throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
  }
  return res.data as T;
}

const BASE = "/v1/fiat";

export class PeridotFiat {
  constructor(private readonly api: ApiLike) {}

  /**
   * Third-party mode: popupBaseUrl set (no first-party session/signer).
   * Write ceremonies delegate to the PeridotID popup; reads stay direct.
   */
  private get delegated(): boolean {
    return this.api.popupBaseUrl != null && this.api.popupRequest != null;
  }

  /** Delegate one trust-critical fiat action to the PeridotID popup. */
  private viaPopup<T>(action: string, payload?: unknown): Promise<T> {
    if (!this.api.popupRequest) {
      throw new Error(
        `Cannot ${action} here — pass popupBaseUrl to approve in the PeridotID popup (third-party origin).`,
      );
    }
    return this.api.popupRequest<T>(action, payload);
  }

  /** Inline-only guard: inquiry/confirm have no popup equivalent. */
  private inlineOnly(method: string): void {
    if (this.delegated) {
      throw new Error(`${method} is first-party inline only — in popup mode use transferViaPopup() for the full approved ceremony.`);
    }
  }

  // --- balance / statement ---

  /** Spendable balance (internal fiat ledger). */
  async balance(): Promise<FiatBalanceView> {
    return unwrap(await this.api.get<FiatBalanceView>(`${BASE}/balance`), "Failed to load balance");
  }

  /** Immutable ledger statement + replay verdict for the caller. */
  async ledger(): Promise<FiatLedgerView> {
    return unwrap(await this.api.get<FiatLedgerView>(`${BASE}/ledger`), "Failed to load statement");
  }

  async feePolicy(): Promise<FeePolicyView> {
    return unwrap(await this.api.get<FeePolicyView>(`${BASE}/fee-policy`), "Failed to load fee policy");
  }

  // --- money-in (DOKU Checkout) ---

  /**
   * Create a Checkout deposit intent: DOKU-hosted page. netAmountIdr is the
   * NET credited to the user (minimum Rp100.000); PeridotID fee + gross
   * payable are quoted upfront. Third-party mode opens the PeridotID popup
   * (`fiat-checkout`) which navigates to the DOKU page on Approve.
   */
  async checkoutDeposit(netAmountIdr: string, clientId?: string): Promise<CheckoutDepositView> {
    if (this.delegated) return this.viaPopup<CheckoutDepositView>("fiat-checkout", { netAmountIdr, clientId });
    return unwrap(await this.api.post<CheckoutDepositView>(`${BASE}/deposits/checkout`, { netAmountIdr, clientId }), "Checkout deposit failed");
  }

  /** Recent deposit intents for the caller (money-in history). */
  async deposits(): Promise<FiatDepositView[]> {
    return unwrap(await this.api.get<FiatDepositView[]>(`${BASE}/deposits`), "Failed to load deposits");
  }

  /** Corroborate a pending deposit against DOKU and credit the ledger. */
  async syncTransaction(id: string): Promise<FiatDepositView> {
    return unwrap(await this.api.post<FiatDepositView>(`${BASE}/deposits/${id}/sync`), "Sync failed");
  }

  // --- send / receive (internal ledger) ---

  /** Send step 1: inquiry only (moves no money). First-party inline only. */
  async transferInquiry(input: FiatTransferInput): Promise<FiatTransferInquiryView> {
    this.inlineOnly("transferInquiry");
    return unwrap(await this.api.post<FiatTransferInquiryView>(`${BASE}/transfers/inquiry`, input), "Account validation failed");
  }

  /** Send step 2: posts all legs atomically. First-party inline only. */
  async transferConfirm(id: string): Promise<FiatLedgerEntry> {
    this.inlineOnly("transferConfirm");
    return unwrap(await this.api.post<FiatLedgerEntry>(`${BASE}/transfers/${id}/confirm`), "Transfer failed");
  }

  /**
   * Full send as one popup ceremony (third-party mode only): the host runs
   * the inquiry, shows the server-verified recipient + amounts, and confirms
   * on Approve.
   */
  async transferViaPopup(input: FiatTransferInput): Promise<FiatLedgerEntry> {
    return this.viaPopup<FiatLedgerEntry>("fiat-transfer", input);
  }

  /** Cancel a created (not yet posted) transfer intent. */
  async cancelTransaction(id: string): Promise<FiatLedgerEntry> {
    return unwrap(await this.api.post<FiatLedgerEntry>(`${BASE}/transfers/${id}/cancel`), "Cancel failed");
  }
}
