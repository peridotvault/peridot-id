// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback } from "react";
import { Text, View } from "react-native";
import type { PopupParams } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { isFiatAction, runAction } from "../feat/auth/utils/popupAction";
import { usePopupRequest } from "../feat/auth/hooks/usePopupRequest";
import { useFiatPrepare } from "../feat/fiat/hooks/useFiatPrepare";
import { PopupReview } from "../feat/auth/components/PopupReview";
import { FiatQuoteBreakdown } from "../feat/fiat/components/FiatQuoteBreakdown";

export function ApproveScreen({ popup, onNeedAuth }: { popup: PopupParams; onNeedAuth?: () => void }) {
  const { peridot } = usePeridot();
  const fiat = useFiatPrepare(peridot);

  const execute = useCallback(async (action: string, payload: unknown) => {
    if (isFiatAction(action)) return fiat.execute(action);
    return { result: await runAction(peridot, action, payload), checkoutUrl: null };
  }, [peridot, fiat.execute]);

  const req = usePopupRequest(peridot, popup, {
    prepare: fiat.prepare,
    execute,
    cancelFiat: fiat.cancelInquiry,
    onNeedAuth,
  });

  return (
    <View style={s.container}>
      <Text style={s.title}>Approve request</Text>
      {req.phase === "waiting" && <Text style={s.hint}>Waiting for the app…</Text>}
      {req.phase === "preparing" && <Text style={s.hint}>Loading verified details…</Text>}
      {req.phase === "redirecting" && <Text style={s.hint}>Opening the payment page…</Text>}
      {req.phase === "done" && <Text style={s.hint}>Done — you can close this window.</Text>}
      {(req.phase === "review" || req.phase === "busy") && (
        <>
          {req.action === "fiat-checkout" && fiat.checkout && (
            <FiatQuoteBreakdown
              quote={fiat.checkout}
              transferFee={fiat.transferFee}
              selectedTotalIdr={fiat.selectedQuote?.totalIdr ?? fiat.checkout.totalIdr}
              method={fiat.checkoutMethod}
              editable={req.phase === "review"}
              onMethod={fiat.setCheckoutMethod}
            />
          )}
          <PopupReview
            summary={req.summary}
            origin={popup.origin}
            busy={req.phase === "busy"}
            onApprove={req.approve}
            onDeny={req.deny}
          />
        </>
      )}
      {req.error && <Text style={s.error}>{req.error}</Text>}
    </View>
  );
}
