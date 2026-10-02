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
  /**
   * Fee operation for the app context. Defaults to `transaction`. `escrow`
   * carries no app fee (campaign funding/refund legs) and, for a verified app,
   * also skips the global fee.
   */
  operation?: "transaction" | "escrow";
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
  /** Total payable (net + PeridotID fee + app fee + gateway fee). */
  grossIdr: string;
  totalIdr?: string;
  /** PeridotID fee (Rp0 for verified apps). */
  feeIdr: string;
  /** The initiating app's own stacked fee (0 when no app context). */
  appFeeIdr?: string;
  /** DOKU payment-gateway fee for the selected method (0 when none selected). */
  gatewayFeeIdr?: string;
  /** Combined display line: PeridotID (fee+PPN) + DOKU (fee+PPN). */
  transferFeeIdr?: string;
  paymentMethod?: string | null;
  netIdr: string;
  feePolicyVersion: number;
  providerStatus: string;
  createdAt: string;
}

/** One payment category (what the picker offers) with its gateway fee + total. */
export interface PaymentMethodQuote {
  /** Category key; pass back as `paymentMethod` on checkout. */
  key: string;
  label: string;
  category: string;
  /** false = not offered (hidden in the wallet). */
  enabled: boolean;
  gatewayFeeIdr: string;
  /** DOKU PPN on the gateway fee (folded into `transferFeeIdr`). */
  gatewayTaxIdr: string;
  rateKey: string;
  source: "doku" | "config";
  totalIdr: string;
}

/** Parts of a top-up fee breakdown (whole-IDR strings). */
export interface TransferFeeParts {
  peridotFeeIdr: string;
  peridotTaxIdr: string;
  gatewayFeeIdr?: string;
  gatewayTaxIdr?: string;
}

/**
 * One combined "Transfer Fee" string = PeridotID fee + PeridotID PPN + DOKU
 * gateway fee + DOKU PPN. Prefer `DepositQuoteView.transferFeeIdr` (server-
 * computed); use this when you hold the parts. Whole-IDR; missing parts = 0.
 */
export function sumTransferFee(parts: TransferFeeParts): string {
  const sum =
    BigInt(parts.peridotFeeIdr || "0") +
    BigInt(parts.peridotTaxIdr || "0") +
    BigInt(parts.gatewayFeeIdr || "0") +
    BigInt(parts.gatewayTaxIdr || "0");
  return sum.toString();
}

/** Transparent top-up quote (moves no money). */
export interface DepositQuoteView {
  amountIdr: string;
  netIdr: string;
  /** PeridotID platform fee (Rp0 for verified apps) — excludes PPN. */
  peridotFeeIdr: string;
  /** PPN on the PeridotID fee (folded into `transferFeeIdr`). */
  peridotTaxIdr: string;
  appFeeIdr: string;
  appCategory: "verified" | "public";
  paymentMethod: string | null;
  /** Whether the selected method's gateway fee is enabled (hide the line if not). */
  gatewayFeeEnabled: boolean;
  gatewayFeeIdr: string;
  /** DOKU PPN on the gateway fee (folded into `transferFeeIdr`). */
  gatewayTaxIdr: string;
  /** Combined display line: PeridotID (fee+PPN) + DOKU (fee+PPN). */
  transferFeeIdr: string;
  totalIdr: string;
  feePolicyVersion: number;
  paymentMethods: PaymentMethodQuote[];
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
  /** PPN (VAT) on the PeridotID fee, basis points (1100 = 11%). */
  taxBps: number;
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
  constructor(
    private readonly api: ApiLike,
    private readonly defaultClientId?: string,
  ) {}

  private appId(explicit?: string): string | undefined {
    return explicit ?? this.defaultClientId;
  }

  /**
   * Third-party mode: popupBaseUrl set (no first-party session/signer).
   * Write ceremonies delegate to the PeridotID popup; reads stay direct.
   */
  private get delegated(): boolean {
    return this.api.popupBaseUrl != null && this.api.popupRequest != null;
  }

  /** True in popup (third-party) mode — send screens should use `transferViaPopup`. */
  get isDelegated(): boolean {
    return this.delegated;
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
   * Quote a top-up (moves no money): Net, PeridotID fee (Rp0 for verified
   * apps), app fee, per-method DOKU gateway fee and total. Render this on the
   * PeridotID checkout summary before creating the deposit.
   */
  async quoteDeposit(input: { netAmountIdr: string; clientId?: string; paymentMethod?: string }): Promise<DepositQuoteView> {
    const cid = this.appId(input.clientId);
    return unwrap(
      await this.api.post<DepositQuoteView>(`${BASE}/deposits/quote`, {
        netAmountIdr: input.netAmountIdr,
        clientId: cid,
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
      }),
      "Top-up quote failed",
    );
  }

  /**
   * Create a Checkout deposit intent: DOKU-hosted page. netAmountIdr is the
   * NET credited to the user (minimum Rp100.000); PeridotID fee + app fee +
   * the selected method's gateway fee and total are quoted upfront.
   * `paymentMethod` (DOKU code) locks the channel at DOKU. Third-party mode
   * opens the PeridotID popup (`fiat-checkout`) which navigates to DOKU on
   * Approve.
   */
  async checkoutDeposit(netAmountIdr: string, clientId?: string, paymentMethod?: string): Promise<CheckoutDepositView> {
    const cid = this.appId(clientId);
    const payload = { netAmountIdr, clientId: cid, ...(paymentMethod ? { paymentMethod } : {}) };
    if (this.delegated) return this.viaPopup<CheckoutDepositView>("fiat-checkout", payload);
    return unwrap(await this.api.post<CheckoutDepositView>(`${BASE}/deposits/checkout`, payload), "Checkout deposit failed");
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
    const clientId = this.appId(input.clientId);
    const body = { ...input, ...(clientId ? { clientId } : {}) };
    return unwrap(await this.api.post<FiatTransferInquiryView>(`${BASE}/transfers/inquiry`, body), "Account validation failed");
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
    const clientId = this.appId(input.clientId);
    return this.viaPopup<FiatLedgerEntry>("fiat-transfer", { ...input, ...(clientId ? { clientId } : {}) });
  }

  /** Cancel a created (not yet posted) transfer intent. */
  async cancelTransaction(id: string): Promise<FiatLedgerEntry> {
    return unwrap(await this.api.post<FiatLedgerEntry>(`${BASE}/transfers/${id}/cancel`), "Cancel failed");
  }
}
