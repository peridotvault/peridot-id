import { ProviderError } from "./provider";

/**
 * Strict IDR parser — the single boundary normalizer for every provider
 * monetary value (balances, history, status, webhooks, notifications).
 * Integer IDR only: no floats, no exp-notation, no commas, no signs.
 * Accepts bigint | integer number | decimal string with zero fraction
 * ("500000", "500000.00"). Anything else throws ProviderError (502) —
 * callers must treat unparseable rows as mismatches, never as zero.
 */
export function parseIdrStrict(raw: unknown, what = "amount"): bigint {
  if (typeof raw === "bigint") {
    if (raw < 0n) throw new ProviderError(502, `DOKU ${what} is negative`);
    return raw;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      throw new ProviderError(502, `DOKU ${what} is not whole IDR`);
    }
    return BigInt(raw);
  }
  if (typeof raw === "string") {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
    if (!m) throw new ProviderError(502, `DOKU ${what} is not whole IDR`);
    if (m[2] !== undefined && /[^0]/.test(m[2])) {
      throw new ProviderError(502, `DOKU ${what} has non-zero fraction`);
    }
    return BigInt(m[1]);
  }
  throw new ProviderError(502, `DOKU ${what} missing`);
}

/** Whole-IDR bigint → V2/Checkout decimal ("500000.00") / integer forms. */
export function idrToDecimalString(idr: bigint): string {
  if (idr < 0n) throw new ProviderError(502, "negative IDR amount");
  return `${idr.toString()}.00`;
}
