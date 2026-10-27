// Pre-approval fee panel (ANT-557, spec ANT-544 FR-B B4 + FR-E E2;
// ANT-731 WS4: WS1 spec §4.1 names the second line "service fee").
//
// Spec rules enforced here:
// - networkFee and serviceFee are ALWAYS separate line items (never a
//   blended total only), then totalFee, then the authorized maxTotalFee bound.
// - maxTotalFee is displayed verbatim: the transaction cannot charge above it.
// - feePolicyVersion + quoted-at/TTL with a live expiry countdown.
// - Quote is unsigned intent data: this panel renders BEFORE any passkey
//   ceremony; nothing here signs or submits.
// - First-action quotes (WS1 §7.1 `activation.required`) add one inclusion
//   line: setup is inside the total, never a separate step.
//
// States: the parent renders loading/error; this panel covers ready + expired.
// Accessibility: expiry and shortfall are role="alert" with focus handoff
// owned by the parent screen (same pattern as Send's send-error).

import { formatFeeAmount, shortfallBaseUnits, shortfallMessage, type NormalizedFeeQuote } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../../shared/styles/theme";
import { formatCountdown, useQuoteCountdown } from "../hooks/useQuoteCountdown";

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col items-center justify-between">
      <span className={`font-sans text-sm ${strong ? "font-bold text-foreground" : "text-muted-foreground"}`}>{label}</span>
      <span className={`font-mono text-sm text-foreground ${strong ? "font-bold" : ""}`}>{value}</span>
    </div>
  );
}

export function FeePanel({
  quote,
  assetSymbol,
  decimals,
  valueBaseUnits,
  balanceBaseUnits,
}: {
  quote: NormalizedFeeQuote;
  /** Display symbol for fee amounts ("SOL", or a mint for token sends). */
  assetSymbol: string;
  /** Base-unit decimals for the fee asset (SOL = 9). */
  decimals: number;
  /** Send amount in base units (for the shortfall line; null hides it). */
  valueBaseUnits?: string | null;
  /** Smart-account balance in base units (for the shortfall line; null hides it). */
  balanceBaseUnits?: string | null;
}) {
  const { remainingMs, expired } = useQuoteCountdown(quote);
  const fmt = (v: string) => formatFeeAmount(v, decimals, assetSymbol);

  const short =
    valueBaseUnits != null && balanceBaseUnits != null
      ? shortfallBaseUnits(balanceBaseUnits, valueBaseUnits, quote.totalFee)
      : null;
  const shortfall = short != null && short !== "0";

  const quotedAt = new Date(quote.quotedAtMs).toLocaleTimeString();

  // ANT-748: name the policy rate on the service line when the quote carries
  // it (pure 50% policy → "Service fee (50%)"). No hardcoded numbers — the
  // label falls back to the bare name when the backend omits the leg.
  const serviceLabel =
    quote.protocolFeeBps != null ? `Service fee (${quote.protocolFeeBps / 100}%)` : "Service fee";

  return (
    <div style={s.card} className="flex flex-col">
      <span style={s.label}>Fee quote</span>
      <div className="flex flex-col gap-1">
        <Row label="Network fee" value={fmt(quote.networkFee)} />
        <Row label={serviceLabel} value={fmt(quote.platformFee)} />
        <Row label="Total fee" value={fmt(quote.totalFee)} strong />
        <Row label="Max total you authorize" value={fmt(quote.maxTotalFee)} strong />
      </div>
      {quote.platformFeeDerived && (
        <p style={s.hint}>Service fee is split from the quoted total (pre-v2 quote).</p>
      )}
      {quote.activation?.required === true && (
        <p style={s.hint}>Includes first-time account setup — no extra step.</p>
      )}
      <p style={s.hint}>
        The transaction cannot charge more than the authorized max. Any spike above it stops the send — nothing is charged.
      </p>
      <p style={s.hint}>
        Fee policy v{quote.feePolicyVersion} · quoted {quotedAt} · expires in {formatCountdown(remainingMs)}
      </p>
      {expired && (
        <p role="alert" style={s.error}>
          Quote expired — cancel and send again for a fresh quote. Do not approve a stale quote.
        </p>
      )}
      {shortfall && (
        <p role="alert" style={s.error}>
          {shortfallMessage({
            balanceBaseUnits: balanceBaseUnits as string,
            valueBaseUnits: valueBaseUnits as string,
            totalFeeBaseUnits: quote.totalFee,
            decimals,
            symbol: assetSymbol,
          })}
        </p>
      )}
    </div>
  );
}
