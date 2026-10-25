"use client";

// Pre-approval fee summary for integrator hosts (ANT-557, spec ANT-544 FR-B B4).
// Opener-side companion to the wallet's FeePanel: render this from a v2 quote
// BEFORE redirecting the user into the approval popup, so the host's own UI
// shows the same separate network/platform lines, total, authorized max,
// policy version, and TTL countdown the wallet will enforce.
//
// Pure + SSR-testable: pass `nowMs` in tests to freeze the countdown.

import { useEffect, useState, type CSSProperties } from "react";
import {
  formatFeeAmount,
  ttlRemainingMs,
  type NormalizedFeeQuote,
} from "@peridotvault/pid-sdk-js";

export interface FeeQuoteSummaryProps {
  quote: NormalizedFeeQuote;
  /** Display symbol for fee amounts. Default "SOL". */
  assetSymbol?: string;
  /** Base-unit decimals for the fee asset. Default 9. */
  decimals?: number;
  /** Override "now" (SSR/tests). Default Date.now(). */
  nowMs?: number;
  /** Re-render every `tickMs` so the countdown stays live. Default 1000; 0 disables. */
  tickMs?: number;
  className?: string;
  style?: CSSProperties;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "04:12" countdown; "expired" once the deadline passes. */
export function formatFeeCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

const list: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.875rem",
  lineHeight: 1.4,
  maxWidth: "100%",
};

const row: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

export function FeeQuoteSummary({
  quote,
  assetSymbol = "SOL",
  decimals = 9,
  nowMs,
  tickMs = 1000,
  className,
  style,
}: FeeQuoteSummaryProps) {
  const [now, setNow] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return;
    if (!tickMs || typeof window === "undefined") return;
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [nowMs, tickMs]);

  const effectiveNow = nowMs ?? now;
  const remaining = ttlRemainingMs(quote, effectiveNow);
  const fmt = (v: string) => formatFeeAmount(v, decimals, assetSymbol);

  return (
    <div className={className} style={{ ...list, ...style }} aria-label="Fee quote">
      <div style={row}>
        <span>Network fee</span>
        <span>{fmt(quote.networkFee)}</span>
      </div>
      <div style={row}>
        <span>Platform fee (Peridot)</span>
        <span>{fmt(quote.platformFee)}</span>
      </div>
      <div style={{ ...row, fontWeight: 700 }}>
        <span>Total fee</span>
        <span>{fmt(quote.totalFee)}</span>
      </div>
      <div style={{ ...row, fontWeight: 700 }}>
        <span>Max total you authorize</span>
        <span>{fmt(quote.maxTotalFee)}</span>
      </div>
      <div style={row}>
        <span>Fee policy</span>
        <span>v{quote.feePolicyVersion}</span>
      </div>
      <div style={row}>
        <span>Quote expires in</span>
        {remaining <= 0 ? (
          <span role="alert">expired — request a fresh quote</span>
        ) : (
          <span>{formatFeeCountdown(remaining)}</span>
        )}
      </div>
    </div>
  );
}
