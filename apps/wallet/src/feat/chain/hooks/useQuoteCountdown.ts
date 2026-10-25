// 1s-ticking countdown to a fee-quote expiry (ANT-557, spec ANT-544 E2).
// Pure TTL math lives in sdk-js (ttlRemainingMs, unit-tested); this hook only
// owns the interval. Timer is cleaned up on unmount (no setState-after-unmount).

import { useEffect, useState } from "react";
import { ttlRemainingMs, type NormalizedFeeQuote } from "@peridotvault/pid-sdk-js";

export function useQuoteCountdown(quote: NormalizedFeeQuote | null, intervalMs = 1000): {
  remainingMs: number | null;
  expired: boolean;
} {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const expiresAtMs = quote?.expiresAtMs ?? null;

  useEffect(() => {
    if (expiresAtMs == null) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [expiresAtMs, intervalMs]);

  if (quote == null || expiresAtMs == null) return { remainingMs: null, expired: false };
  const remainingMs = ttlRemainingMs(quote, nowMs);
  return { remainingMs, expired: remainingMs <= 0 };
}

/** "04:12" for countdown display; "expired" once the deadline passes. */
export function formatCountdown(remainingMs: number | null): string {
  if (remainingMs == null) return "—";
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
