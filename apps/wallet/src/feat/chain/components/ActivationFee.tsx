// Activation fee display (ANT-561, backend ANT-555 → UI ANT-557; EVM ANT-736).
//
// v2 activation views (canonical envelope) render the full FeePanel —
// separate network/platform lines, total, authorized maxTotalFee bound,
// policy version, expiry countdown. Legacy v1 views render the network-fee
// line only (never a blended or invented total).
//
// SVM and EVM views share this path (AC-8): the caller picks the display
// asset (SOL/9 for SVM, the native asset + decimals for EVM chains).
//
// Pure view switch over tested units (activationFeeQuote, FeePanel); the
// parent owns loading/error/expired-focus states.

import { formatFeeAmount, type ActivationView, type EvmActivationView } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../../shared/styles/theme";
import { flatten } from "../../../shared/styles/stylesheet";
import { activationFeeQuote, type ActivationFeeView } from "../utils/activationFee";
import { FeePanel } from "./FeePanel";

export function ActivationFee({
  view,
  assetSymbol = "SOL",
  decimals = 9,
}: {
  view: ActivationView | EvmActivationView | null;
  /** Display symbol for fee amounts ("SOL", or the EVM chain native asset). */
  assetSymbol?: string;
  /** Base-unit decimals for the fee asset (SOL = 9, EVM natives = 18). */
  decimals?: number;
}) {
  if (!view) return null;
  const quote = activationFeeQuote(view as ActivationFeeView);
  if (quote) return <FeePanel quote={quote} assetSymbol={assetSymbol} decimals={decimals} />;
  const legacyLamports = "networkFeeLamports" in view ? String(view.networkFeeLamports) : null;
  return (
    <div style={s.card} className="flex flex-col">
      <span style={flatten([s.label, { marginBottom: 6 }])}>Fee quote</span>
      <span className="font-sans text-sm text-muted-foreground">
        {legacyLamports != null ? (
          <>
            Network fee ≈ {formatFeeAmount(legacyLamports, decimals, assetSymbol)} (pre-v2 quote — the
            full breakdown with platform fee and authorized max appears with fee-policy v2 quotes).
          </>
        ) : (
          <>Fee breakdown unavailable for this quote — refresh to try again.</>
        )}
      </span>
    </div>
  );
}
