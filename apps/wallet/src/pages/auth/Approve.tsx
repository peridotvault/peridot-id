// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback, useEffect, useState } from "react";

import type { PopupParams } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../../shared/app/AppContext";
import { UIButton } from "../../shared/components/ui/UIButton";
import { isFiatAction, runAction } from "../../feat/auth/utils/popupAction";
import { assertExecuteGateAllows } from "../../feat/auth/utils/knownPrograms";
import { usePopupRequest, type PopupAuthReason } from "../../feat/auth/hooks/usePopupRequest";
import { useAppInfo } from "../../feat/auth/hooks/useAppInfo";
import { useFiatPrepare } from "../../feat/fiat/hooks/useFiatPrepare";
import { PopupReview } from "../../feat/auth/components/PopupReview";
import { ConsentShell } from "../../feat/auth/components/ConsentShell";
import { SigningScreen } from "../../feat/auth/components/SigningScreen";
import { FiatQuoteBreakdown } from "../../feat/fiat/components/FiatQuoteBreakdown";

const PHASE_HINT: Record<string, string> = {
  waiting: "Waiting for the app…",
  preparing: "Loading verified details…",
  redirecting: "Opening the payment page…",
};

export function Approve({ popup, onNeedAuth }: { popup: PopupParams; onNeedAuth?: (reason?: PopupAuthReason) => void }) {
  const { peridot } = usePeridot();
  const fiat = useFiatPrepare(peridot);
  // App the request came from: name + verified are server-sourced (fail-closed
  // to hidden), the origin badge in PopupReview is the value the user verifies.
  const appInfo = useAppInfo(peridot, popup.clientId, popup.origin);
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

  // Handed back to the opener: same terminal animation as the login popup.
  if (req.phase === "done") {
    return <SigningScreen origin={popup.origin} appName={appInfo?.name} logoUrl={appInfo?.logoUrl} />;
  }

  const reviewing = req.phase === "review" || req.phase === "busy";

  return (
    <ConsentShell>
      {reviewing ? (
        <PopupReview
          summary={req.action === "fiat-checkout" ? (fiat.checkoutSummary ?? req.summary) : req.summary}
          origin={popup.origin}
          appName={appInfo?.name}
          logoUrl={appInfo?.logoUrl}
          description={appInfo?.description}
          verified={appInfo?.isVerified}
          details={
            req.action === "fiat-checkout" && fiat.checkout ? (
              <FiatQuoteBreakdown
                quote={fiat.checkout}
                transferFee={fiat.transferFee}
                selectedTotalIdr={fiat.selectedQuote?.totalIdr ?? fiat.checkout.totalIdr}
                method={fiat.checkoutMethod}
                editable={req.phase === "review"}
                onMethod={fiat.setCheckoutMethod}
              />
            ) : null
          }
          busy={req.phase === "busy"}
          onApprove={onApprove}
          onDeny={req.deny}
          approvingPid={req.approvingPid}
          switched={req.switched}
          gate={req.gate}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
        />
      ) : req.phase === "failed" ? (
        <>
          <h1 className="self-start text-left font-sans text-xl font-semibold text-foreground">Approve request</h1>
          <UIButton title="Close" sfx="action" onPress={() => void req.deny(req.expectedPid ? "wrong_account" : "access_denied")} />
        </>
      ) : (
        <>
          <h1 className="self-start text-left font-sans text-xl font-semibold text-foreground">Approve request</h1>
          <p role="status" className="text-xs text-muted-foreground">{PHASE_HINT[req.phase] ?? ""}</p>
        </>
      )}
      {req.error && <p role="alert" tabIndex={-1} id="approve-error" className="text-sm text-danger">{req.error}</p>}
    </ConsentShell>
  );
}
