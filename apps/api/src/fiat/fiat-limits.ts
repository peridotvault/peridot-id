/** Global fiat limits — one value for every app. No env, no per-app override. */

/** Minimum Checkout top-up / direct payment, NET IDR. API-enforced only
 *  (DOKU configures no minimum-deposit rule). */
export const MIN_CHECKOUT_NET_IDR = 10_000n;

/** Hard cap for a single direct app payment (gross credited to the beneficiary). */
export const MAX_PAYMENT_IDR = 10_000_000n;
