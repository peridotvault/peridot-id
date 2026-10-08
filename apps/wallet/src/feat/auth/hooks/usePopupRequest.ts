import { useCallback, useEffect, useRef, useState } from "react";
import {
  awaitPopupRequest,
  postPopupReady,
  postPopupResult,
  type PeridotClient,
  type PopupParams,
} from "@peridotvault/pid-sdk-js";
import { isFiatAction, isSessionError, isStepUpError, signInHint, summarize } from "../utils/popupAction";

export type PopupPhase = "waiting" | "preparing" | "review" | "busy" | "redirecting" | "done" | "failed";

// Popup handshake + approve/deny orchestration. Fiat steps are injected:
// prepare returns the verified summary text, execute runs the money action.
export type PopupAuthReason = "step-up" | "login";

export function usePopupRequest(
  peridot: PeridotClient,
  popup: PopupParams,
  opts: {
    prepare: (action: string, payload: Record<string, unknown>) => Promise<string>;
    execute: (action: string, payload: unknown) => Promise<{ result: unknown; checkoutUrl: string | null }>;
    cancelFiat: () => void;
    onNeedAuth?: (reason?: PopupAuthReason) => void;
  },
) {
  const [phase, setPhase] = useState<PopupPhase>("waiting");
  const [action, setAction] = useState(popup.action);
  const [payload, setPayload] = useState<unknown>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Handlers close over per-render fiat state — the handshake effect must not
  // re-subscribe, so it reads through a ref (same reason as the old
  // eslint-disable on [popup.origin]).
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const peridotRef = useRef(peridot);
  peridotRef.current = peridot;

  // One silent refresh attempt: turns an expired 15m access into a live
  // session (30d refresh) without bouncing to login. Max once per call site
  // (refresh endpoint is throttled server-side). Returns true when the caller
  // should retry once, otherwise forwards step-up/login to onNeedAuth.
  const tryRefreshOnce = useCallback(async (): Promise<boolean> => {
    let refreshed: true | "step-up" | false = false;
    try {
      refreshed = await peridotRef.current.auth.refresh();
    } catch {
      refreshed = false;
    }
    if (refreshed === true) return true;
    if (refreshed === "step-up") optsRef.current.onNeedAuth?.("step-up");
    else optsRef.current.onNeedAuth?.("login");
    return false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        postPopupReady(popup.origin);
        const req = await awaitPopupRequest(popup.origin);
        if (cancelled) return;
        setAction(req.action);
        setPayload(req.payload);
        const p = (req.payload ?? {}) as Record<string, unknown>;
        if (isFiatAction(req.action)) {
          setPhase("preparing");
          try {
            setSummary(await optsRef.current.prepare(req.action, p));
          } catch (e) {
            // Access expired while idle: revive via refresh cookie, then retry
            // prepare once before giving up to login.
            if (isSessionError(e) && (await tryRefreshOnce())) {
              if (cancelled) return;
              setSummary(await optsRef.current.prepare(req.action, p));
            } else if (isSessionError(e) && optsRef.current.onNeedAuth) {
              return;
            } else {
              throw e;
            }
          }
        } else {
          setSummary(summarize(req.action, req.payload));
        }
        if (!cancelled) setPhase("review");
      } catch (e) {
        if (!cancelled) {
          if (isSessionError(e) && optsRef.current.onNeedAuth) {
            if (await tryRefreshOnce()) {
              // Refresh revived a non-fiat path (summary is local): go to review.
              setPhase("review");
              return;
            }
            return;
          }
          setError(signInHint(e));
          setPhase("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popup.origin, tryRefreshOnce]);

  const deny = useCallback(() => {
    // Best-effort cleanup of server state created during prepare. The checkout
    // quote moves no money (no row), so only a transfer inquiry needs cancelling.
    optsRef.current.cancelFiat();
    postPopupResult(popup.origin, { ok: false, error: "access_denied" });
    setPhase("done");
  }, [popup.origin]);

  const approve = useCallback(async () => {
    setPhase("busy");
    setError(null);
    const run = () => optsRef.current.execute(action, payload);
    try {
      const { result, checkoutUrl } = await run();
      // Checkout keeps the window open and navigates itself to the DOKU
      // payment page: same-window navigation from the Approve click can't be
      // popup-blocked, unlike a dapp-side async popup.
      postPopupResult(
        popup.origin,
        { ok: true, data: result },
        checkoutUrl ? { keepOpen: true } : undefined,
      );
      if (checkoutUrl && typeof window !== "undefined") {
        setPhase("redirecting");
        window.location.assign(checkoutUrl);
        return;
      }
      setPhase("done");
    } catch (e) {
      // Session gone mid-flow (e.g. access expired while reviewing): revive via
      // refresh cookie and retry once. The popup params persist across the OAuth
      // round-trip, so only forward to login when refresh can't revive. Don't
      // post a failure — the request is still pending.
      if (isSessionError(e) && (await tryRefreshOnce())) {
        try {
          const { result, checkoutUrl } = await run();
          postPopupResult(
            popup.origin,
            { ok: true, data: result },
            checkoutUrl ? { keepOpen: true } : undefined,
          );
          if (checkoutUrl && typeof window !== "undefined") {
            setPhase("redirecting");
            window.location.assign(checkoutUrl);
            return;
          }
          setPhase("done");
          return;
        } catch (retryError) {
          if (isSessionError(retryError) && optsRef.current.onNeedAuth) {
            optsRef.current.onNeedAuth(isStepUpError(retryError) ? "step-up" : "login");
            return;
          }
          const message = retryError instanceof Error ? retryError.message : String(retryError);
          try {
            postPopupResult(popup.origin, { ok: false, error: message });
          } catch {
            // opener gone — show it here instead
          }
          setError(signInHint(message));
          setPhase("review");
          return;
        }
      }
      if (isSessionError(e) && optsRef.current.onNeedAuth) {
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      try {
        postPopupResult(popup.origin, { ok: false, error: message });
      } catch {
        // opener gone — show it here instead
      }
      setError(signInHint(message));
      setPhase("review");
    }
  }, [popup.origin, action, payload, tryRefreshOnce]);

  return { phase, action, summary, error, approve, deny };
}
