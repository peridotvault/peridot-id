// DOKU Sub-Account V2 SNAP client (V2 ONLY — no V1 endpoints).
// Official docs: developers.doku.com/wallet-as-a-service/sub-account/sub-account-v2
// (+ integration-guide for per-endpoint OpenAPI).
//
// Only endpoints + fields documented there are implemented. Deliberately NOT
// implemented (no V2 contract — see docs/FIAT_SUBACCOUNT.md blockers):
// per-channel Direct API schemas, split-rule list/get/update/delete,
// KYC/tiers, limits/fees numbers, webhook signing, DOKU_WALLET specifics.
// Bank-agnostic money-in runs through DOKU Checkout (see ./checkout.ts).
// Spendable user balance lives on the Unified Ledger (POINT accounts):
// issue via DOKU_NON_FIAT top-up, move via DOKU_SUB_ACCOUNT + POINT,
// spend via POINT debit (retires to DOKU_SYSTEM_POINT).
//
// Auth: B2B token (Get Token B2B) + per-call SNAP headers
// (X-PARTNER-ID / X-TIMESTAMP / X-SIGNATURE HMAC-SHA512 / X-EXTERNAL-ID).
// Success envelope: responseCode "2xxxxxx". Transaction states come from
// latestTransactionStatus ("00"=Success "03"=Pending "04"=Refunded
// "06"=Failed; "05"=Canceled is void-topup only).
//
// Hosts: api-sandbox.doku.com / api.doku.com (documented servers for V2).

import { ProviderError } from "./provider";
import { parseIdrStrict } from "./money";
import {
  b2bSignature,
  snapAmount,
  snapExternalId,
  snapSignature,
  snapTimestamp,
} from "./doku/snap";

export const DOKU_SANDBOX_URL = "https://api-sandbox.doku.com";
export const DOKU_PROD_URL = "https://api.doku.com";

const SAC_B2B_TOKEN_PATH = "/authorization/v1/access-token/b2b";

export const SAC_REGISTER_PATH = "/sub-account/v2.0/register";
export const SAC_BALANCE_PATH = "/sub-account/v2.0/balance-inquiries";
export const SAC_HISTORY_PATH = "/sub-account/v2.0/transaction-history-list";
export const SAC_TX_STATUS_PATH = "/sub-account/v2.0/transactions-status";
export const SAC_TRANSFER_INQUIRY_PATH = "/sub-account/v2.0/transfer-inquiry";
export const SAC_TRANSFER_PAYMENT_PATH = "/sub-account/v2.0/transfer-payment";
export const SAC_DEBIT_PATH = "/sub-account/v2.0/debit";
export const SAC_DEBIT_CANCEL_PATH = "/sub-account/v2.0/debit/cancel";
export const SAC_TOPUP_VOID_PATH = "/sub-account/v2.0/topup/void";
export const SAC_SPLIT_RULE_PATH = "/sub-account/v2.0/split-rules";

/** Unique merchant reference (≤64 chars per V2 schema). */
export function buildInvoiceNumber(prefix = "PID"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${rand}`.slice(0, 64);
}

/** V2 transfer destination types (documented enum). */
export type SacTransferType = "BANK_ACCOUNT" | "DOKU_SUB_ACCOUNT" | "DOKU_WALLET" | "DOKU_NON_FIAT";

/** Ledger currency: IDR (fiat) or POINT (Unified Ledger, non-cash, 1:1 IDR peg). */
export type SacCurrency = "IDR" | "POINT";

export type SacChannel = "BI_FAST" | "ONLINE";

export interface DokuSubAccountConfig {
  mode: "sandbox" | "production";
  clientId: string;
  secretKey: string;
  /** RSA private key PEM for the B2B token (DOKU dashboard). Required. */
  privateKey: string;
}

export interface SacAccountInfo {
  type: string;
  currency: string;
  accountNo: string;
}

export interface SacRegisterResult {
  profileId: string;
  parentProfileId?: string;
  accounts: SacAccountInfo[];
  /** Static BRI VA number when DOKU returns it under a known key (see blocker). */
  vaNumber?: string;
  rawResponse: unknown;
}

export interface SacBalanceAccount {
  type: string;
  currency: string;
  accountNo: string;
  available: string;
  reserved: string;
}

export interface SacBalance {
  profileId: string;
  name?: string;
  accounts: SacBalanceAccount[];
  rawResponse: unknown;
}

export interface SacHistoryItem {
  mutationType?: string;
  transactionType?: string;
  /** Raw amount as returned by DOKU (display only — never parsed here). */
  amount?: string;
  /** Whole-IDR normalization of amount; undefined when unparseable
   *  (reconciliation must flag such rows, never treat them as zero). */
  amountIdr?: string;
  currency?: string;
  status?: string;
  dateTime?: string;
  remark?: string;
  partnerReferenceNo?: string;
  referenceNo?: string;
  channel?: string;
}

export interface SacTxStatus {
  partnerReferenceNo: string;
  transactionType?: string;
  /** "00" Success | "03" Pending | "04" Refunded | "06" Failed (+ "05" void only). */
  latestTransactionStatus?: string;
  latestTransactionDesc?: string;
  transactionDate?: string;
  amount?: { value?: string; currency?: string };
  rawResponse: unknown;
}

export interface SacTransferInquiry {
  referenceNo: string;
  partnerReferenceNo: string;
  beneficiaryAccountName?: string;
  rawResponse: unknown;
}

export interface SacTransferPayment {
  referenceNo?: string;
  transactionDate?: string;
  rawResponse: unknown;
}

export interface SacDebit {
  referenceNo?: string;
  latestTransactionStatus?: string;
  rawResponse: unknown;
}

export interface SacDebitCancel {
  refundNo?: string;
  latestTransactionStatus?: string;
  rawResponse: unknown;
}

export interface SacTopupVoid {
  latestTransactionStatus?: string;
  rawResponse: unknown;
}

export interface SacSplitRuleItem {
  type: "PERCENTAGE" | "FLAT";
  value: number;
  currency?: string;
  accountNumber: number;
}

/** Map V2 latestTransactionStatus → Peridot providerStatus. Unknown stays processing. */
export function mapSacStatus(code: string | undefined | null): "settled" | "processing" | "failed" | "cancelled" | "refunded" {
  const c = String(code ?? "").trim();
  if (c === "00") return "settled";
  if (c === "06") return "failed";
  if (c === "04") return "refunded";
  if (c === "05") return "cancelled";
  return "processing";
}

/** Versioned platform service-fee policy. fee is a FLAT percent of the quoted
 *  amount: fee = round-half-up(amount * percentBps / 10_000). No floor, no
 *  cap. minIdr/maxIdr are retained as schema/policy fields but are NOT
 *  applied (both must be 0).
 *  Peridot computes the QUOTE only. Settlement of the fee itself happens
 *  natively at DOKU via a static PERCENTAGE split rule (NET remainder → user
 *  sub-account, percent → Treasury); the API never debits a fee after
 *  settlement. See docs/FIAT_SUBACCOUNT.md. */
export interface FeePolicy {
  version: number;
  percentBps: number;
  /** Unused, always 0 (kept for schema compat). */
  minIdr: bigint;
  /** Unused, always 0 = uncapped (kept for schema compat). */
  maxIdr: bigint;
}

export const DEFAULT_FEE_POLICY: FeePolicy = {
  version: 3,
  percentBps: 500, // flat 5%
  minIdr: 0n,
  maxIdr: 0n,
};

/** Flat fee = round-half-up(amount * percentBps / 10_000). No floor, no cap. */
export function calcServiceFee(amountIdr: bigint, policy: FeePolicy = DEFAULT_FEE_POLICY): bigint {
  return (amountIdr * BigInt(policy.percentBps) + 5_000n) / 10_000n;
}

/** Provider-agnostic Sub-Account boundary — swapping DOKU later means one new class. */
export interface SubAccountProvider {
  readonly name: string;
  register(input: {
    partnerReferenceNo: string;
    type?: string;
    name: string;
    email: string;
    phoneNo?: string;
    countryCode?: string;
    parentProfileId?: string;
  }): Promise<SacRegisterResult>;
  balance(profileId: string, accounts?: string[]): Promise<SacBalance>;
  history(input: {
    accountNo: string;
    fromDateTime: string;
    toDateTime: string;
    pageSize: string;
    pageNumber: string;
  }): Promise<{ items: SacHistoryItem[]; rawResponse: unknown }>;
  txStatus(partnerReferenceNo: string): Promise<SacTxStatus>;
  transferInquiry(input: {
    partnerReferenceNo: string;
    type: SacTransferType;
    amountIdr: bigint;
    /** Ledger currency. Default IDR. POINT = Unified Ledger (DOKU_NON_FIAT
     *  top-up, or DOKU_SUB_ACCOUNT P2P). */
    currency?: SacCurrency;
    fromAccount: string;
    beneficiaryAccountNumber: string;
    beneficiaryBankCode?: string;
    channel?: SacChannel;
    remark?: string;
  }): Promise<SacTransferInquiry>;
  transferPayment(input: {
    partnerReferenceNo: string;
    referenceNo: string;
    type: SacTransferType;
    amountIdr: bigint;
    /** Ledger currency. Must match the inquiry. Default IDR. */
    currency?: SacCurrency;
    fromAccount: string;
    beneficiaryAccountNumber: string;
    beneficiaryAccountName: string;
    beneficiaryBankCode?: string;
    channel?: SacChannel;
  }): Promise<SacTransferPayment>;
  debit(input: {
    partnerReferenceNo: string;
    fromAccount: string;
    amountIdr: bigint;
    /** Ledger currency. POINT debits retire to DOKU_SYSTEM_POINT. Default IDR. */
    currency?: SacCurrency;
    description?: string;
  }): Promise<SacDebit>;
  debitCancel(input: {
    partnerReferenceNo: string;
    originalPartnerReferenceNo: string;
    refundAmountIdr: bigint;
    /** Ledger currency. Must match the original debit. Default IDR. */
    currency?: SacCurrency;
    originalReferenceNo?: string;
    reason?: string;
  }): Promise<SacDebitCancel>;
  /**
   * Reverse a point top-up IN FULL (VOID_TOPUP). Full amount only, NOT
   * idempotent (double-void → 403), flips original rows to VOID. Prefer
   * POINT debit for partial/retry-safe clawbacks.
   */
  topupVoid(input: {
    partnerReferenceNo: string;
    originalPartnerReferenceNo: string;
    voidAmountIdr: bigint;
  }): Promise<SacTopupVoid>;
  createSplitRule(input: { transactionType: string; rules: SacSplitRuleItem[] }): Promise<{ splitRuleId?: string; rawResponse: unknown }>;
}

export class DokuSubAccountProvider implements SubAccountProvider {
  readonly name = "doku-sub-account";
  private b2bToken: string | null = null;
  private b2bExp = 0;

  constructor(private readonly config: DokuSubAccountConfig) {}

  private base(): string {
    return this.config.mode === "production" ? DOKU_PROD_URL : DOKU_SANDBOX_URL;
  }

  private key(): string {
    const pem = (this.config.privateKey ?? "").replace(/\\n/g, "\n");
    if (!pem) throw new ProviderError(null, "DOKU Sub-Account not configured — set DOKU_PRIVATE_KEY");
    return pem;
  }

  private async accessToken(): Promise<string> {
    if (this.b2bToken && Date.now() < this.b2bExp) return this.b2bToken;
    const timestamp = snapTimestamp();
    const body = JSON.stringify({ grantType: "client_credentials" });
    const data = await this.postRaw(
      SAC_B2B_TOKEN_PATH,
      body,
      {
        "X-SIGNATURE": b2bSignature(this.config.clientId, timestamp, this.key()),
        "X-TIMESTAMP": timestamp,
        "X-CLIENT-KEY": this.config.clientId,
        "Content-Type": "application/json",
      },
      "token",
    );
    const token: string | undefined = data?.accessToken;
    if (!token) {
      throw new ProviderError(null, `DOKU Sub-Account B2B token failed: ${String(data?.responseMessage ?? "unknown").slice(0, 200)}`, undefined, data);
    }
    const ttl = Number(data?.expiresIn ?? 900);
    this.b2bToken = token;
    this.b2bExp = Date.now() + Math.max(60, (Number.isFinite(ttl) ? ttl : 900) - 60) * 1000;
    return token;
  }

  private async postRaw(path: string, body: string, headers: Record<string, string>, what: string): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, { method: "POST", headers, body });
    } catch {
      throw new ProviderError(null, "Payment gateway unreachable");
    }
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || !data) {
      const msg = String((data as any)?.responseMessage ?? res.statusText ?? "unknown").slice(0, 200);
      throw new ProviderError(res.status, `DOKU Sub-Account ${what} failed (${res.status}): ${msg}`, undefined, data);
    }
    return data;
  }

  private async sacCall(path: string, bodyObj: Record<string, unknown>): Promise<Record<string, any>> {
    const token = await this.accessToken();
    const body = JSON.stringify(bodyObj);
    const timestamp = snapTimestamp();
    const headers: Record<string, string> = {
      "X-PARTNER-ID": this.config.clientId,
      "X-EXTERNAL-ID": snapExternalId(),
      "X-TIMESTAMP": timestamp,
      "X-SIGNATURE": snapSignature({
        method: "POST",
        endpointUrl: path,
        accessToken: token,
        minifiedBody: body,
        timestamp,
        clientSecret: this.config.secretKey,
      }),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const data = await this.postRaw(path, body, headers, path);
    const code = String(data?.responseCode ?? "");
    if (!code.startsWith("2")) {
      const msg = String(data?.responseMessage ?? "unknown").slice(0, 200);
      throw new ProviderError(code.startsWith("4") ? 400 : 502, `DOKU Sub-Account ${path} (${code || "?"}): ${msg}`, undefined, data);
    }
    return data;
  }

  async register(input: {
    partnerReferenceNo: string;
    type?: string;
    name: string;
    email: string;
    phoneNo?: string;
    countryCode?: string;
    parentProfileId?: string;
  }): Promise<SacRegisterResult> {
    const data = await this.sacCall(SAC_REGISTER_PATH, {
      partnerReferenceNo: input.partnerReferenceNo,
      type: input.type ?? "DEFAULT",
      name: input.name,
      email: input.email,
      ...(input.phoneNo ? { phoneNo: input.phoneNo } : {}),
      ...(input.countryCode ? { countryCode: input.countryCode } : {}),
      ...(input.parentProfileId ? { parentProfileId: input.parentProfileId } : {}),
    });
    if (!data?.profileId) throw new ProviderError(502, "DOKU Sub-Account register missing profileId", undefined, data);
    const accounts: SacAccountInfo[] = Array.isArray(data.accounts)
      ? data.accounts.map((a: any) => ({ type: String(a?.type ?? ""), currency: String(a?.currency ?? ""), accountNo: String(a?.accountNo ?? "") }))
      : [];
    // Static BRI VA: docs promise one per sub-account but name no response
    // field — read the known candidates, else leave undefined (blocker).
    const vaNumber =
      data?.vaNumber != null ? String(data.vaNumber)
      : data?.virtualAccountNo != null ? String(data.virtualAccountNo)
      : undefined;
    return {
      profileId: String(data.profileId),
      parentProfileId: data?.parentProfileId ? String(data.parentProfileId) : undefined,
      accounts,
      vaNumber,
      rawResponse: data,
    };
  }

  async balance(profileId: string, accounts?: string[]): Promise<SacBalance> {
    const data = await this.sacCall(SAC_BALANCE_PATH, {
      profileId,
      ...(accounts && accounts.length > 0 ? { accounts } : {}),
    });
    const list: SacBalanceAccount[] = Array.isArray(data?.accounts)
      ? data.accounts.map((a: any) => ({
          type: String(a?.type ?? ""),
          currency: String(a?.currency ?? ""),
          accountNo: String(a?.accountNo ?? ""),
          available: a?.balance?.available != null ? String(a.balance.available) : "0",
          reserved: a?.balance?.reserved != null ? String(a.balance.reserved) : "0",
        }))
      : [];
    return {
      profileId: String(data?.profileId ?? profileId),
      name: data?.name ? String(data.name) : undefined,
      accounts: list,
      rawResponse: data,
    };
  }

  async history(input: {
    accountNo: string;
    fromDateTime: string;
    toDateTime: string;
    pageSize: string;
    pageNumber: string;
  }): Promise<{ items: SacHistoryItem[]; rawResponse: unknown }> {
    const data = await this.sacCall(SAC_HISTORY_PATH, { ...input });
    const list: any[] = Array.isArray(data?.detailData) ? data.detailData : [];
    const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));
    const idr = (v: unknown): string | undefined => {
      try {
        return parseIdrStrict(v, "history amount").toString();
      } catch {
        return undefined; // unparseable — reconciliation flags it, never zeroes it
      }
    };
    return {
      items: list.map((t: any) => ({
        mutationType: str(t?.mutationType),
        transactionType: str(t?.transactionType),
        amount: str(t?.amount),
        amountIdr: idr(t?.amount),
        currency: str(t?.currency),
        status: str(t?.status),
        dateTime: str(t?.dateTime),
        remark: str(t?.remark),
        partnerReferenceNo: str(t?.partnerReferenceNo),
        referenceNo: str(t?.referenceNo),
        channel: str(t?.channel),
      })),
      rawResponse: data,
    };
  }

  async txStatus(partnerReferenceNo: string): Promise<SacTxStatus> {
    const data = await this.sacCall(SAC_TX_STATUS_PATH, { partnerReferenceNo });
    const amount = data?.amount as any;
    return {
      partnerReferenceNo: String(data?.partnerReferenceNo ?? partnerReferenceNo),
      transactionType: data?.transactionType ? String(data.transactionType) : undefined,
      latestTransactionStatus: data?.latestTransactionStatus ? String(data.latestTransactionStatus) : undefined,
      latestTransactionDesc: data?.latestTransactionDesc ? String(data.latestTransactionDesc) : undefined,
      transactionDate: data?.transactionDate ? String(data.transactionDate) : undefined,
      amount: amount ? { value: amount.value != null ? String(amount.value) : undefined, currency: amount.currency ? String(amount.currency) : undefined } : undefined,
      rawResponse: data,
    };
  }

  async transferInquiry(input: {
    partnerReferenceNo: string;
    type: SacTransferType;
    amountIdr: bigint;
    currency?: SacCurrency;
    fromAccount: string;
    beneficiaryAccountNumber: string;
    beneficiaryBankCode?: string;
    channel?: SacChannel;
    remark?: string;
  }): Promise<SacTransferInquiry> {
    const data = await this.sacCall(SAC_TRANSFER_INQUIRY_PATH, {
      partnerReferenceNo: input.partnerReferenceNo,
      type: input.type,
      amount: { value: snapAmount(input.amountIdr), currency: input.currency ?? "IDR" },
      fromAccount: input.fromAccount,
      beneficiaryAccountNumber: input.beneficiaryAccountNumber,
      ...(input.beneficiaryBankCode ? { beneficiaryBankCode: input.beneficiaryBankCode } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.remark ? { remark: input.remark } : {}),
    });
    if (!data?.referenceNo) throw new ProviderError(502, "DOKU Sub-Account inquiry missing referenceNo", undefined, data);
    return {
      referenceNo: String(data.referenceNo),
      partnerReferenceNo: String(data.partnerReferenceNo ?? input.partnerReferenceNo),
      beneficiaryAccountName: data?.beneficiaryAccountName ? String(data.beneficiaryAccountName) : undefined,
      rawResponse: data,
    };
  }

  async transferPayment(input: {
    partnerReferenceNo: string;
    referenceNo: string;
    type: SacTransferType;
    amountIdr: bigint;
    currency?: SacCurrency;
    fromAccount: string;
    beneficiaryAccountNumber: string;
    beneficiaryAccountName: string;
    beneficiaryBankCode?: string;
    channel?: SacChannel;
  }): Promise<SacTransferPayment> {
    const data = await this.sacCall(SAC_TRANSFER_PAYMENT_PATH, {
      // partnerReferenceNo MUST equal the inquiry's (documented).
      partnerReferenceNo: input.partnerReferenceNo,
      referenceNo: input.referenceNo,
      type: input.type,
      amount: { value: snapAmount(input.amountIdr), currency: input.currency ?? "IDR" },
      fromAccount: input.fromAccount,
      beneficiaryAccountNumber: input.beneficiaryAccountNumber,
      beneficiaryAccountName: input.beneficiaryAccountName,
      ...(input.beneficiaryBankCode ? { beneficiaryBankCode: input.beneficiaryBankCode } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    });
    return {
      referenceNo: data?.referenceNo ? String(data.referenceNo) : undefined,
      transactionDate: data?.transactionDate ? String(data.transactionDate) : undefined,
      rawResponse: data,
    };
  }

  async debit(input: {
    partnerReferenceNo: string;
    fromAccount: string;
    amountIdr: bigint;
    currency?: SacCurrency;
    description?: string;
  }): Promise<SacDebit> {
    const data = await this.sacCall(SAC_DEBIT_PATH, {
      partnerReferenceNo: input.partnerReferenceNo,
      fromAccount: input.fromAccount,
      transactionType: "PURCHASE",
      amount: { value: snapAmount(input.amountIdr), currency: input.currency ?? "IDR" },
      ...(input.description ? { description: input.description } : {}),
    });
    return {
      referenceNo: data?.referenceNo ? String(data.referenceNo) : undefined,
      latestTransactionStatus: data?.latestTransactionStatus ? String(data.latestTransactionStatus) : undefined,
      rawResponse: data,
    };
  }

  async debitCancel(input: {
    partnerReferenceNo: string;
    originalPartnerReferenceNo: string;
    refundAmountIdr: bigint;
    currency?: SacCurrency;
    originalReferenceNo?: string;
    reason?: string;
  }): Promise<SacDebitCancel> {
    const data = await this.sacCall(SAC_DEBIT_CANCEL_PATH, {
      partnerReferenceNo: input.partnerReferenceNo,
      originalPartnerReferenceNo: input.originalPartnerReferenceNo,
      ...(input.originalReferenceNo ? { originalReferenceNo: input.originalReferenceNo } : {}),
      transactionType: "REFUND_PURCHASE",
      refundAmount: { value: snapAmount(input.refundAmountIdr), currency: input.currency ?? "IDR" },
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return {
      refundNo: data?.refundNo ? String(data.refundNo) : undefined,
      latestTransactionStatus: data?.latestTransactionStatus ? String(data.latestTransactionStatus) : undefined,
      rawResponse: data,
    };
  }

  async topupVoid(input: {
    partnerReferenceNo: string;
    originalPartnerReferenceNo: string;
    voidAmountIdr: bigint;
  }): Promise<SacTopupVoid> {
    const data = await this.sacCall(SAC_TOPUP_VOID_PATH, {
      partnerReferenceNo: input.partnerReferenceNo,
      originalPartnerReferenceNo: input.originalPartnerReferenceNo,
      transactionType: "VOID_TOPUP",
      voidAmount: { value: snapAmount(input.voidAmountIdr), currency: "POINT" },
    });
    return {
      latestTransactionStatus: data?.latestTransactionStatus ? String(data.latestTransactionStatus) : undefined,
      rawResponse: data,
    };
  }

  async createSplitRule(input: { transactionType: string; rules: SacSplitRuleItem[] }): Promise<{ splitRuleId?: string; rawResponse: unknown }> {
    const data = await this.sacCall(SAC_SPLIT_RULE_PATH, {
      transactionType: input.transactionType,
      rules: input.rules,
    });
    return {
      splitRuleId: data?.splitRuleId ? String(data.splitRuleId) : undefined,
      rawResponse: data,
    };
  }
}

// ponytail: self-check — `node dist/subaccount.js` fails loudly if helpers break.
if (require.main === module) {
  const assert = require("node:assert");
  assert.ok(SAC_REGISTER_PATH === "/sub-account/v2.0/register", "register path");
  assert.ok(SAC_TRANSFER_PAYMENT_PATH === "/sub-account/v2.0/transfer-payment", "payment path");
  assert.strictEqual(mapSacStatus("00"), "settled", "status 00");
  assert.strictEqual(mapSacStatus("03"), "processing", "status 03");
  assert.strictEqual(mapSacStatus("04"), "refunded", "status 04");
  assert.strictEqual(mapSacStatus("06"), "failed", "status 06");
  assert.strictEqual(mapSacStatus(undefined), "processing", "unknown stays processing");
  assert.strictEqual(calcServiceFee(30_000n), 1_500n, "30k -> 5% 1.5k");
  assert.strictEqual(calcServiceFee(100_000n), 5_000n, "100k -> 5k");
  assert.strictEqual(calcServiceFee(500_000n), 25_000n, "500k -> 5% 25k");
  assert.strictEqual(calcServiceFee(1_000_000n), 50_000n, "1M -> flat 5% 50k, no cap");
  assert.strictEqual(calcServiceFee(10_000_000n), 500_000n, "10M -> flat 5% 500k");
  assert.strictEqual(calcServiceFee(99_999n), 5_000n, "half-up rounding");
  assert.strictEqual(calcServiceFee(200_000n), 10_000n, "200k -> 5% 10k");
  console.log("pid-payments subaccount self-check OK");
}
