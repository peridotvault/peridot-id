/** Max input digits (Checkout order.amount is an integer ≤12 digits). */
export const MAX_INPUT_DIGITS = 12;

/** Minimum Checkout top-up, NET IDR (mirrors the API; the API rejects below). */
export const MIN_NET_IDR = 100_000n;

/** Keep digits only (paste-safe), strip leading zeros, cap length. */
export function digitsOnly(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits.slice(0, MAX_INPUT_DIGITS);
}

/** Group digits id-ID for display: "100000" → "100.000". Empty stays empty. */
export function groupDigits(digits: string): string {
  if (!digits) return "";
  return Number(digits).toLocaleString("id-ID");
}
