// DOKU Checkout (JOKUL hosted payment page) client — bank-agnostic money-in.
// Official docs: developers.doku.com/accept-payments/doku-checkout
// (backend-integration: endpoint, headers, body) +
// docs.doku.com/wallet-as-a-service/sub-account/collect-and-route
// (additional_info.account routing into a Sub-Account).
//
// Only fields documented there are sent. Deliberately NOT covered:
// per-channel Direct API schemas (GitBook file tags, not inlined).
//
// Auth is NON-SNAP: Client-Id / Request-Id / Request-Timestamp /
// Signature HMACSHA256=base64(HMAC-SHA256(secret,
//   "Client-Id:..\nRequest-Id:..\nRequest-Timestamp:..\nRequest-Target:..\nDigest:.."))
// with Digest=base64(SHA-256(body)) and UTC `...Z` timestamps.
// Success: HTTP 200 + message[] containing SUCCESS + response.payment.url.
// Failure: HTTP 400 {error_messages[]}.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { ProviderError } from "./provider";
import { DOKU_PROD_URL, DOKU_SANDBOX_URL } from "./subaccount";

export const CHECKOUT_PAYMENT_PATH = "/checkout/v1/payment";

/**
 * SAC routing key inside Checkout `additional_info`.
 * The SAC guide shows camelCase `additionalInfo.account`; Checkout's own
 * schema is snake_case (`additional_info`) and does not list `account` —
 * snake_case is implemented to match the Checkout contract.
 * SANDBOX-VERIFY: if DOKU expects camelCase here, change this one constant.
 */
export const CHECKOUT_SAC_ACCOUNT_KEY = "account";

/** DOKU-rendered locale for the hosted page/receipt (documented `order.language`). */
export const CHECKOUT_LANGUAGE = "ID";

export interface DokuCheckoutConfig {
  mode: "sandbox" | "production";
  /** Same merchant Client ID as the SAC integration (DOKU dashboard). */
  clientId: string;
  /** Same merchant Secret Key (used for the non-SNAP HMAC-SHA256). */
  secretKey: string;
}

export interface CheckoutPaymentInput {
  /** Merchant invoice number, ≤30 chars (card-acquirer limit applies). */
  invoiceNumber: string;
  /** Gross amount, whole IDR (Checkout takes an integer, no decimals). */
  grossAmountIdr: bigint;
  /** Destination Sub-Account profileId (SAC-…). */
  profileId: string;
  splitRuleId?: string;
  customer: { id?: string; name?: string; phone?: string; email?: string };
  /** Documented payment_method_types allowlist; omitted = all active channels. */
  paymentMethodTypes?: string[];
  /** Checkout page lifetime in minutes (default 60, per docs). */
  dueMinutes?: number;
  /** Per-payment notify URL override (documents: additional_info.override_notification_url). */
  notifyUrl?: string;
}

export interface CheckoutPaymentResult {
  paymentUrl: string;
  tokenId: string;
  expiredDate?: string;
  sessionId?: string;
  rawResponse: unknown;
}

/** UTC ISO8601 `...Z` timestamp (Checkout runs on UTC, not WIB). */
export function checkoutTimestamp(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

function checkoutDigest(minifiedBody: string): string {
  return createHash("sha256").update(minifiedBody).digest("base64");
}

function checkoutSignature(opts: {
  clientId: string;
  requestId: string;
  requestTimestamp: string;
  requestTarget: string;
  digest: string;
  secretKey: string;
}): string {
  const raw =
    `Client-Id:${opts.clientId}\n` +
    `Request-Id:${opts.requestId}\n` +
    `Request-Timestamp:${opts.requestTimestamp}\n` +
    `Request-Target:${opts.requestTarget}\n` +
    `Digest:${opts.digest}`;
  return `HMACSHA256=${createHmac("sha256", opts.secretKey).update(raw).digest("base64")}`;
}

export class DokuCheckoutClient {
  readonly name = "doku-checkout";

  constructor(private readonly config: DokuCheckoutConfig) {}

  private base(): string {
    return this.config.mode === "production" ? DOKU_PROD_URL : DOKU_SANDBOX_URL;
  }

  async createPayment(input: CheckoutPaymentInput): Promise<CheckoutPaymentResult> {
    if (!/^[A-Za-z0-9-]{1,30}$/.test(input.invoiceNumber)) {
      throw new ProviderError(400, "invoiceNumber must be 1-30 alphanumerics/dashes (card-acquirer limit)");
    }
    if (input.grossAmountIdr <= 0n) throw new ProviderError(400, "gross amount must be positive");
    if (input.grossAmountIdr > 999_999_999_999n) throw new ProviderError(400, "gross amount exceeds Checkout 12-digit limit");
    const bodyObj: Record<string, unknown> = {
      // language: DOKU-rendered page/receipt locale (documented optional).
      order: { amount: Number(input.grossAmountIdr), invoice_number: input.invoiceNumber, currency: "IDR", language: CHECKOUT_LANGUAGE },
      payment: {
        payment_due_date: input.dueMinutes ?? 60,
        ...(input.paymentMethodTypes ? { payment_method_types: input.paymentMethodTypes } : {}),
      },
      customer: {
        ...(input.customer.id ? { id: input.customer.id } : {}),
        ...(input.customer.name ? { name: input.customer.name } : {}),
        ...(input.customer.phone ? { phone: input.customer.phone } : {}),
        ...(input.customer.email ? { email: input.customer.email } : {}),
      },
      additional_info: {
        [CHECKOUT_SAC_ACCOUNT_KEY]: {
          id: input.profileId,
          ...(input.splitRuleId ? { split_rule_id: input.splitRuleId } : {}),
        },
        ...(input.notifyUrl ? { override_notification_url: input.notifyUrl } : {}),
      },
    };
    const body = JSON.stringify(bodyObj);
    const requestId = randomUUID();
    const timestamp = checkoutTimestamp();
    const headers = {
      "Client-Id": this.config.clientId,
      "Request-Id": requestId,
      "Request-Timestamp": timestamp,
      Signature: checkoutSignature({
        clientId: this.config.clientId,
        requestId,
        requestTimestamp: timestamp,
        requestTarget: CHECKOUT_PAYMENT_PATH,
        digest: checkoutDigest(body),
        secretKey: this.config.secretKey,
      }),
      "Content-Type": "application/json",
    };
    let res: Response;
    try {
      res = await fetch(`${this.base()}${CHECKOUT_PAYMENT_PATH}`, { method: "POST", headers, body });
    } catch {
      throw new ProviderError(null, "Payment gateway unreachable");
    }
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || !data) {
      const errs = Array.isArray((data as any)?.error_messages) ? (data as any).error_messages.join("; ") : undefined;
      const msg = String(errs ?? (data as any)?.message ?? res.statusText ?? "unknown").slice(0, 200);
      throw new ProviderError(res.status, `DOKU Checkout payment failed (${res.status}): ${msg}`, requestId, data);
    }
    const messages: string[] = Array.isArray(data?.message) ? data.message.map(String) : [];
    const payment = (data?.response?.payment ?? {}) as Record<string, any>;
    if (!messages.some((m) => m.toUpperCase().includes("SUCCESS")) || !payment?.url) {
      throw new ProviderError(502, `DOKU Checkout payment unclear: ${messages.join("; ").slice(0, 150) || "no payment url"}`, requestId, data);
    }
    return {
      paymentUrl: String(payment.url),
      tokenId: payment.token_id ? String(payment.token_id) : "",
      expiredDate: payment.expired_date ? String(payment.expired_date) : undefined,
      sessionId: data?.response?.order?.session_id ? String(data.response.order.session_id) : undefined,
      rawResponse: data,
    };
  }
}

// ponytail: self-check — `node dist/checkout.js` fails loudly if helpers break.
if (require.main === module) {
  const assert = require("node:assert");
  const sig = checkoutSignature({
    clientId: "C", requestId: "R", requestTimestamp: "2020-08-11T08:45:42Z",
    requestTarget: CHECKOUT_PAYMENT_PATH, digest: checkoutDigest("{}"), secretKey: "S",
  });
  assert.ok(sig.startsWith("HMACSHA256="), "non-SNAP signature prefix");
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(checkoutTimestamp(new Date("2020-08-11T08:45:42.123Z"))), "UTC Z timestamp");
  assert.strictEqual(CHECKOUT_LANGUAGE, "ID", "checkout locale");
  console.log("pid-payments checkout self-check OK");
}
