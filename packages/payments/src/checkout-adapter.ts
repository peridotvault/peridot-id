// Provider-neutral money-in contract. The API depends on THIS, never on a
// vendor SDK: vendor request signing, status mapping and notification parsing
// live inside the adapter that implements it. Switching the backend adapter
// must not change public SDK shapes, and outstanding intents keep reconciling
// through the adapter they were created with (see `FiatPayment.provider`).
import type { CheckoutOrderStatus, CheckoutPaymentInput, CheckoutPaymentResult } from "./checkout.js";

/**
 * Notification body reduced to the three documented facts the money-in path
 * needs. `amountRaw` stays raw on purpose: the caller compares it to the
 * invoiced total and fails closed when it cannot be parsed.
 */
export interface CheckoutNotification {
  invoiceNumber: string;
  amountRaw: unknown;
  txStatus?: string;
}

/** One payment gateway adapter (money-in). */
export interface CheckoutAdapter {
  /** Stable routing key persisted with each intent. */
  readonly name: string;
  createPayment(input: CheckoutPaymentInput): Promise<CheckoutPaymentResult>;
  checkOrderStatus(invoiceNumber: string): Promise<CheckoutOrderStatus>;
  /** Live method fee, or null when the gateway exposes no fee API. */
  transactionFee(methodCode: string, amountIdr: bigint): Promise<bigint | null>;
  /** Vendor notification body → the facts above; null when unparseable. */
  parseNotification(body: unknown): CheckoutNotification | null;
}

/** Adapter registry keyed by `CheckoutAdapter.name`. */
export type CheckoutAdapters = Readonly<Record<string, CheckoutAdapter>>;
