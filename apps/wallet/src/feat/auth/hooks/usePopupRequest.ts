import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  awaitPopupRequest,
  postPopupReady,
  postPopupResult,
  type PeridotClient,
  type PopupParams,
} from "@peridotvault/pid-sdk-js";
import type { AccountView } from "@peridotvault/pid-types";
import { isFiatAction, isSessionError, isStepUpError, signInHint, summarize } from "../utils/popupAction";
import { assertExecuteGateAllows, getExecuteGate } from "../utils/knownPrograms";
import { play } from "../../../shared/sfx/player";

export type PopupPhase = "waiting" | "preparing" | "review" | "busy" | "redirecting" | "done" | "failed";

// Cookie namespace this popup approves under when the dapp asks for another
// identity than the wallet's active one. Scoped, so the approval signs as that
// account without switching (or restoring) the wallet's own cookie.
const APPROVAL_SCOPE = "approval";

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
  // The pid this popup will sign as (label for every flow; binding when the
  // opener sent one). True when we switched to it just for this approval.
  const [approvingPid, setApprovingPid] = useState<string | null>(null);
  const [expectedPid, setExpectedPid] = useState<string | null>(null);
  const [switched, setSwitched] = useState(false);

  // Handlers close over per-render fiat state — the handshake effect must not
  // re-subscribe, so it reads through a ref (same reason as the old
  // eslint-disable on [popup.origin]).
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const peridotRef = useRef(peridot);
  peridotRef.current = peridot;
  const approverRef = useRef<string | null>(null);

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
        // Best-effort active pid via /v1/auth/* (never fires onUnauthorized —
        // the client only calls it off that namespace). Null when signed out.
        const activePid = async (): Promise<string | null> => {
          try {
            const res = await peridotRef.current.auth.accounts();
            if (!Array.isArray(res)) return null;
            return (res as AccountView[]).find((a) => a.isActive)?.pid ?? null;
          } catch {
            return null;
          }
        };
        // Bind the approval to the dapp's account (REQUEST wins, URL param is
        // the OAuth-round-trip fallback): auto-switch when it is signed in
        // this browser, refuse when it isn't — never sign as the wallet tab's
        // account by accident. Without a binding, just label the approver.
        const expected = req.expectedPid ?? popup.expectedPid ?? null;
        if (expected) setExpectedPid(expected);
        let approver = await activePid();
        if (expected) {
          if (!approver) {
            if (await tryRefreshOnce()) approver = await activePid();
            else return; // refresh failed: onNeedAuth already fired
          }
          if (!approver) {
            optsRef.current.onNeedAuth?.("login");
            return;
          }
          if (approver !== expected) {
            let ok = false;
            try {
              ok = await peridotRef.current.auth.grantSession(APPROVAL_SCOPE, expected);
            } catch {
              ok = false;
            }
            if (ok) {
              // Sign the rest of this popup as that identity; the confirmed
              // /me below proves the scope really resolves to it.
              peridotRef.current.setSessionScope(APPROVAL_SCOPE);
              try {
                ok = ((await peridotRef.current.identity.me()) as { pid?: string }).pid === expected;
              } catch {
                ok = false;
              }
              if (!ok) peridotRef.current.setSessionScope(undefined);
            }
            if (!ok) {
              if (!cancelled) {
                setError(
                  `This request is for ${expected}, which isn't signed in here (this window is ${approver}). Deny it, add ${expected} on the wallet, then retry from the app.`,
                );
                setPhase("failed");
              }
              return;
            }
            if (!cancelled) setSwitched(true);
            approver = expected;
          }
        }
        if (!cancelled && approver) {
          approverRef.current = approver;
          setApprovingPid(approver);
        }
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
          play("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popup.origin, popup.expectedPid, tryRefreshOnce]);

  const deny = useCallback(async (error = "access_denied") => {
    // Best-effort cleanup of server state created during prepare. The checkout
    // quote moves no money (no row), so only a transfer inquiry needs cancelling.
    optsRef.current.cancelFiat();
    postPopupResult(popup.origin, { ok: false, error });
    setPhase("done");
    play("cancelled");
  }, [popup.origin]);

  const approve = useCallback(async (opts?: { unknownAcknowledged?: boolean }) => {
    // Unknown-target / malformed execute gate: enforced BEFORE any passkey
    // ceremony or /v1/wallet/execute call (AC7). Deny is unaffected.
    try {
      assertExecuteGateAllows(action, payload, { unknownAcknowledged: opts?.unknownAcknowledged });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      play("failed");
      return;
    }
    setPhase("busy");
    setError(null);
    const run = () => optsRef.current.execute(action, payload);
    // Deliver success: echo the approving pid so the dapp can verify it got
    // the exact account it asked for.
    const deliver = async (result: unknown, checkoutUrl: string | null) => {
      const approver = approverRef.current;
      const data =
        result && typeof result === "object"
          ? { ...(result as Record<string, unknown>), ...(approver ? { approvedPid: approver } : {}) }
          : result;
      // Checkout keeps the window open and navigates itself to the DOKU
      // payment page: same-window navigation from the Approve click can't be
      // popup-blocked, unlike a dapp-side async popup.
      postPopupResult(popup.origin, { ok: true, data }, checkoutUrl ? { keepOpen: true } : undefined);
      play("approved");
      if (checkoutUrl && typeof window !== "undefined") {
        setPhase("redirecting");
        window.location.assign(checkoutUrl);
        return;
      }
      setPhase("done");
    };
    try {
      const { result, checkoutUrl } = await run();
      await deliver(result, checkoutUrl);
    } catch (e) {
      // Session gone mid-flow (e.g. access expired while reviewing): revive via
      // refresh cookie and retry once. The popup params persist across the OAuth
      // round-trip, so only forward to login when refresh can't revive. Don't
      // post a failure — the request is still pending.
      if (isSessionError(e) && (await tryRefreshOnce())) {
        try {
          const { result, checkoutUrl } = await run();
          await deliver(result, checkoutUrl);
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
          play("failed");
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
      play("failed");
    }
  }, [popup.origin, action, payload, tryRefreshOnce]);

  // Execute disclosure gate, derived purely from action+payload (no network).
  // Recomputed each render so the review screen and approve() agree.
  const gate = useMemo(() => getExecuteGate(action, payload), [action, payload]);

  return { phase, action, summary, error, approve, deny, approvingPid, expectedPid, switched, gate };
}
