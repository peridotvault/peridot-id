// DOKU Checkout implementation of PaymentProvider. All DOKU specifics
// (headers, signature, body/response shapes) live here and in checkout.ts.

import { createHmac, randomUUID } from "node:crypto";
import {
  buildStringToSign,
  checkoutHeaders,
  DOKU_CHECKOUT_PATH,
  DOKU_PROD_URL,
  DOKU_SANDBOX_URL,
  sha256Base64,
  verifyCheckoutSignature,
} from "../checkout";
import type { CreatedInvoice, CreateInvoiceInput, PaymentProvider, WebhookEvent } from "../provider";

export interface DokuProviderConfig {
  mode: "sandbox" | "production";
  clientId: string;
  secretKey: string;
}

export class DokuProvider implements PaymentProvider {
  readonly name = "doku";

  constructor(private readonly config: DokuProviderConfig) {}

  private base(): string {
    return this.config.mode === "production" ? DOKU_PROD_URL : DOKU_SANDBOX_URL;
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    // Basic Checkout request (no method restriction = payer picks any DOKU method).
    const body = JSON.stringify({
      order: {
        amount: Number(input.amountIdr),
        invoice_number: input.invoiceNumber,
        currency: "IDR",
        callback_url: input.callbackUrl,
        payment_due_date: Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000)),
      },
      customer: { id: input.pid },
    });
    const headers = checkoutHeaders({
      clientId: this.config.clientId,
      requestId: randomUUID(),
      body,
      secretKey: this.config.secretKey,
    });

    const res = await fetch(`${this.base()}${DOKU_CHECKOUT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    // ponytail: shape is defensive — DOKU wraps the URL a few levels deep.
    const paymentUrl: string | null =
      data?.response?.payment?.url ?? data?.payment?.url ?? data?.data?.payment?.url ?? null;
    if (!res.ok || !paymentUrl) {
      throw new Error(`DOKU checkout rejected: ${JSON.stringify(data)?.slice(0, 200)}`);
    }
    return { paymentUrl, rawResponse: data };
  }

  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    notifyPath: string,
  ): boolean {
    const received = headers["signature"] ?? headers["Signature"];
    const clientId = headers["client-id"] ?? headers["Client-Id"];
    const requestId = headers["request-id"] ?? headers["Request-Id"];
    const requestTimestamp = headers["request-timestamp"] ?? headers["Request-Timestamp"];
    if (!received || !clientId || !requestId || !requestTimestamp) return false;
    const stringToSign = buildStringToSign({
      clientId,
      requestId,
      requestTimestamp,
      requestTarget: notifyPath,
      digest: sha256Base64(rawBody),
    });
    const mac = createHmac("sha256", this.config.secretKey).update(stringToSign).digest("base64");
    return verifyCheckoutSignature(`HMACSHA256=${mac}`, received);
  }

  parseWebhook(rawBody: string): WebhookEvent | null {
    let body: Record<string, any>;
    try {
      body = JSON.parse(rawBody) as Record<string, any>;
    } catch {
      return null;
    }
    const invoiceNumber: string | undefined = body?.order?.invoice_number ?? body?.invoice_number;
    if (!invoiceNumber) return null;
    const txStatus = String(body?.transaction?.status ?? body?.status ?? "").toUpperCase();
    const status = txStatus.includes("SUCCESS") ? "paid" : txStatus.includes("EXPIR") ? "expired" : "failed";
    return { invoiceNumber, status, rawResponse: body };
  }
}
