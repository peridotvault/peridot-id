// Activation fee display (ANT-561, backend ANT-555 → UI ANT-557).
//
// v2 activation views (canonical envelope) render the full FeePanel —
// separate network/platform lines, total, authorized maxTotalFee bound,
// policy version, expiry countdown. Legacy v1 views render the network-fee
// line only (never a blended or invented total).
//
// Pure view switch over tested units (activationFeeQuote, FeePanel); the
// parent owns loading/error/expired-focus states.

import { formatFeeAmount, type ActivationView } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../../shared/styles/theme";
import { flatten } from "../../../shared/styles/stylesheet";
import { activationFeeQuote } from "../utils/activationFee";
import { FeePanel } from "./FeePanel";

export function ActivationFee({ view }: { view: ActivationView | null }) {
  if (!view) return null;
  const quote = activationFeeQuote(view);
  if (quote) return <FeePanel quote={quote} assetSymbol="SOL" decimals={9} />;
  return (
    <div style={s.card} className="flex flex-col">
      <span style={flatten([s.label, { marginBottom: 6 }])}>Fee quote</span>
      <span className="font-sans text-sm text-muted-foreground">
        Network fee ≈ {formatFeeAmount(String(view.networkFeeLamports), 9, "SOL")} (pre-v2 quote — the
        full breakdown with platform fee and authorized max appears with fee-policy v2 quotes).
      </span>
    </div>
  );
}
