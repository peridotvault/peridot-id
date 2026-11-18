import type { CheckoutAdapter, CheckoutAdapters } from "@peridotvault/pid-payments";

/** Injection token for the adapter that creates NEW money-in intents. */
export const CHECKOUT_CLIENT = "CHECKOUT_CLIENT";
/** Injection token for every configured adapter, keyed by `name` (reconciliation). */
export const CHECKOUT_ADAPTERS = "CHECKOUT_ADAPTERS";
export type { CheckoutAdapter, CheckoutAdapters };
