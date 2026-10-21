// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "../shared/primitives";
import type { PopupParams } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";
import { isFiatAction, runAction } from "../feat/auth/utils/popupAction";
import { assertExecuteGateAllows } from "../feat/auth/utils/knownPrograms";
import { usePopupRequest, type PopupAuthReason } from "../feat/auth/hooks/usePopupRequest";
import { useFiatPrepare } from "../feat/fiat/hooks/useFiatPrepare";
import { PopupReview } from "../feat/auth/components/PopupReview";
import { FiatQuoteBreakdown } from "../feat/fiat/components/FiatQuoteBreakdown";

export function ApproveScreen({ popup, onNeedAuth }: { popup: PopupParams; onNeedAuth?: (reason?: PopupAuthReason) => void }) {
  const { peridot } = usePeridot();
  const fiat = useFiatPrepare(peridot);
  // Unknown-target acknowledgement (ANT-262): owned here so BOTH the review UI
  // (checkbox gating) and the approve path (pre-ceremony enforcement) read the
  // same value. Reset whenever a new request arrives.
  const [acknowledged, setAcknowledged] = useState(false);

  const execute = useCallback(async (action: string, payload: unknown) => {
    if (isFiatAction(action)) return fiat.execute(action);
    // First-party/direct execute path: same gate as the popup (spec FR5).
    // Throws before any passkey ceremony when acknowledgement is missing.
    assertExecuteGateAllows(action, payload, { unknownAcknowledged: acknowledged });
    return { result: await runAction(peridot, action, payload), checkoutUrl: null };
  }, [peridot, fiat.execute, acknowledged]);

  const req = usePopupRequest(peridot, popup, {
    prepare: fiat.prepare,
    execute,
    cancelFiat: fiat.cancelInquiry,
    onNeedAuth,
  });

  // A new request payload re-enters review with acknowledgement cleared, so a
  // previous tick can never carry over to a different call.
  useEffect(() => {
    setAcknowledged(false);
  }, [req.action, req.summary]);

  // ANT-341 FR1: move focus to the error on failed approve (SR + keyboard).
  useEffect(() => {
    if (req.error) document.getElementById("approve-error")?.focus?.();
  }, [req.error]);

  const onApprove = useCallback(() => {
    void req.approve({ unknownAcknowledged: acknowledged });
  }, [req.approve, acknowledged]);

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
            summary={req.action === "fiat-checkout" ? (fiat.checkoutSummary ?? req.summary) : req.summary}
            origin={popup.origin}
            busy={req.phase === "busy"}
            onApprove={onApprove}
            onDeny={req.deny}
            approvingPid={req.approvingPid}
            switched={req.switched}
            gate={req.gate}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
          />
        </>
      )}
      {req.phase === "failed" && (
        <UIButton title="Close" onPress={() => void req.deny(req.expectedPid ? "wrong_account" : "access_denied")} />
      )}
      {req.error && <Text role="alert" tabIndex={-1} id="approve-error" style={s.error}>{req.error}</Text>}
    </View>
  );
}
