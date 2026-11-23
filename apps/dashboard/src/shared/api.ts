import type { ApiError } from "@peridotvault/pid-sdk-js";

/** Unwrap a raw SDK response or throw a readable error. */
export function unwrap<T>(res: { ok: boolean; data: T | ApiError }, what: string): T {
  if (!res.ok || (typeof res.data === "object" && res.data !== null && "statusCode" in res.data)) {
    const err = res.data as ApiError;
    const detail = Array.isArray(err.message) ? err.message.join("; ") : err.message;
    throw new Error(detail || `${what} failed`);
  }
  return res.data as T;
}
