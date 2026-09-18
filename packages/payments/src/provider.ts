// Provider-agnostic fiat gateway boundary. Adding Xendit/Stripe later means
// one new file implementing PaymentProvider — the API, SDK, and wallet stay closed.

export type WebhookStatus = "paid" | "expired" | "failed";

export interface CreateInvoiceInput {
  pid: string;
  amountIdr: bigint;
  invoiceNumber: string;
  expiresAt: Date;
  callbackUrl: string;
}

export interface CreatedInvoice {
  paymentUrl: string;
  /** Raw gateway response, stored verbatim for debugging/reconciliation. */
  rawResponse: unknown;
}

export interface WebhookEvent {
  invoiceNumber: string;
  status: WebhookStatus;
  rawResponse: unknown;
}

export interface PaymentProvider {
  /** Stable id used in the DB (`provider`) and the webhook route (`:provider`). */
  readonly name: string;
  /** Create a hosted-page invoice at the gateway. Throws on gateway failure. */
  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice>;
  /** Authenticity check for an incoming webhook (raw bytes, gateway-signed). */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, notifyPath: string): boolean;
  /** Parse an authenticated webhook into a ledger event (null = unparseable). */
  parseWebhook(rawBody: string): WebhookEvent | null;
}
