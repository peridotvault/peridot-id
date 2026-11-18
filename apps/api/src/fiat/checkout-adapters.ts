// Money-in adapter wiring. Exactly one active adapter creates new intents;
// every persisted intent remembers which adapter created it, so reconciliation
// keeps using that one after a switch. An unconfigured/unknown provider name
// fails at boot instead of silently falling back.
import { DokuCheckoutClient, type CheckoutAdapter, type CheckoutAdapters } from "@peridotvault/pid-payments";

/** DOKU Checkout — the only adapter implemented today. */
export const DOKU_CHECKOUT_PROVIDER = "doku-checkout";

export interface CheckoutAdapterConfig {
  /** `PAYMENT_CHECKOUT_PROVIDER`; defaults to DOKU. */
  provider?: string;
  mode: "sandbox" | "production";
  clientId: string;
  secretKey: string;
}

export function createCheckoutAdapters(config: CheckoutAdapterConfig): {
  adapters: CheckoutAdapters;
  active: CheckoutAdapter;
} {
  const provider = config.provider?.trim() || DOKU_CHECKOUT_PROVIDER;
  const adapters: Record<string, CheckoutAdapter> = {
    [DOKU_CHECKOUT_PROVIDER]: new DokuCheckoutClient({
      mode: config.mode,
      clientId: config.clientId,
      secretKey: config.secretKey,
    }),
  };
  const active = adapters[provider];
  if (!active) {
    throw new Error(`Unknown PAYMENT_CHECKOUT_PROVIDER "${provider}" (implemented: ${Object.keys(adapters).join(", ")})`);
  }
  return { adapters, active };
}
