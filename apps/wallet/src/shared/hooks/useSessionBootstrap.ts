import { useCallback, useEffect, useRef, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { needsProvisioning } from "../app/fiatEnsure";
import { landingScreen } from "../app/landing";
import { cachedRead, clearApiCache } from "../data/apiCache";

// Shell screen map. Owned here (not in App.tsx) so the session hooks and the
// shell share one vocabulary; the router JSX stays in App.
export type Screen =
  | "login"
  | "home"
  | "send"
  | "receive"
  | "swap"
  | "topup"
  | "provisioning"
  | "passkey"
  | "chains"
  | "settings"
  | "profile"
  | "edit-profile"
  | "sessions"
  | "connected"
  | "app-connections"
  | "activity"
  | "activity-detail"
  | "fiat-detail"
  | "fiat-account"
  | "fiat-transfer"
  | "fiat-ledger-detail";

// Session lifecycle: bootstrap, post-auth routing, account-switch reload.
// Shell-wide (not feature-scoped), so it lives in shared/hooks.
export function useSessionBootstrap(
  peridot: PeridotClient,
  opts: {
    /** Auth-in-a-new-tab context (shape owned by feat/auth; only truthiness matters here). */
    loginContext: unknown;
    setScreen: (s: Screen) => void;
    /** Hold bootstrap until true (embedded wallet waits for the parent's bearer). */
    paused?: boolean;
  },
) {
  const { loginContext, setScreen, paused = false } = opts;
  const [bootstrapping, setBootstrapping] = useState(true);
  // True when the session family aged out (google families: 7 days) — the
  // login screen then asks for passkey confirmation instead of silently dying.
  const [stepUp, setStepUp] = useState(false);
  // Whether a first-party session exists, resolved at bootstrap. An approval
  // popup opened without one renders the login screen first (then resumes the
  // handshake) instead of dead-ending on a 401.
  const [authed, setAuthed] = useState(false);
  // Bumped to re-run bootstrap after an account switch (same cookies, new identity).
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // StrictMode double-mounts in dev, firing me→refresh→me twice (doubled
  // 401s in the console). Skip the remount replay; bumps still re-run.
  const ranEpoch = useRef(-1);

  // After an account switch the cookies point at a new identity: re-bootstrap
  // so every screen re-fetches under it (and drop back to Home).
  const reloadSession = useCallback(() => {
    setBootstrapping(true);
    setScreen("home");
    setSessionEpoch((n) => n + 1);
  }, [setScreen]);

  // A claim ticket is a cookie, not a session: it survives a reload and outlives
  // the account that is signed in, so every post-auth route must consult it.
  const hasPendingClaim = useCallback(async () => {
    try {
      return (await peridot.auth.claimStatus()).pending === true;
    } catch {
      return false;
    }
  }, [peridot]);

  // Post-auth landing: show the stepper only when something actually needs
  // provisioning (fresh account, failed/skipped setup); returning users go
  // straight home. The check is read-only — never traps at login.
  const routeAfterAuth = useCallback(async () => {
    // Auth-in-a-new-tab stays on the login screen: it must deliver the pid_code.
    if (loginContext) {
      setScreen("login");
      return;
    }
    // A verified credential with no identity yet still needs the PID picker —
    // this is the "add account" case, where a session is already signed in and
    // home used to swallow the claim.
    const pending = await hasPendingClaim();
    let need = false;
    if (!pending) {
      try {
        need = await needsProvisioning(peridot);
      } catch {
        need = false;
      }
    }
    setScreen(landingScreen({ authInNewTab: false, pendingClaim: pending, needsSetup: need }));
  }, [peridot, loginContext, setScreen, hasPendingClaim]);

  const handleLoggedIn = useCallback(() => {
    // A login or a claim can land a different identity than the one whose data
    // is cached (add account, SSO round-trip): never serve the previous one.
    clearApiCache();
    setStepUp(false);
    setAuthed(true);
    void routeAfterAuth();
  }, [routeAfterAuth]);

  // After a Google OAuth redirect returns, detect the existing session and go straight home.
  // Short-lived access tokens are revived via the refresh cookie first, so a
  // valid session survives app restarts instead of bouncing to login.
  // A hung request (no resolve, no reject, no error) must not freeze the
  // splash: the timer forces the gate open and late resolves are ignored.
  const bootstrap = useCallback(async () => {
    let alive = true;
    const timer = setTimeout(() => {
      alive = false;
      // eslint-disable-next-line no-console
      console.warn("[startup] bootstrap timed out after 10s — continuing logged-out");
      setBootstrapping(false);
    }, 10000);
    try {
      // Shared with Home's first load (5s) — same row, same second.
      let me = await cachedRead("identity.me", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.me());
      if (typeof me === "object" && me !== null && "statusCode" in me) {
        const refreshed = await peridot.auth.refresh();
        if (refreshed === "step-up") {
          if (alive) setStepUp(true);
        } else if (refreshed === true) {
          me = await cachedRead("identity.me", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.me());
        }
      }
      if (alive && me && !("statusCode" in me)) {
        setAuthed(true);
        if (loginContext) {
          // Auth-in-a-new-tab: keep the login screen mounted so it can deliver
          // the pid_code to the opener (or show the PID picker if none yet).
          setScreen("login");
        } else {
          // Same rule as routeAfterAuth: a pending claim (new credential while
          // another account is signed in) belongs on the PID picker, not home.
          const pending = await hasPendingClaim();
          let need = false;
          if (!pending) {
            try {
              need = await needsProvisioning(peridot);
            } catch {
              need = false;
            }
          }
          setScreen(landingScreen({ authInNewTab: false, pendingClaim: pending, needsSetup: need }));
        }
      }
    } catch {
      // not logged in — stay on login
      setAuthed(false);
    } finally {
      // Drop a spent ?pid_code= so it can't be re-read on re-render (web only).
      if (typeof window !== "undefined") {
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.has("pid_code")) {
            url.searchParams.delete("pid_code");
            window.history.replaceState({}, "", url.toString());
          }
        } catch {
          // non-fatal
        }
      }
      clearTimeout(timer);
      if (alive) setBootstrapping(false);
    }
  }, [peridot, loginContext, setScreen, hasPendingClaim]);

  useEffect(() => {
    if (paused) return;
    if (ranEpoch.current === sessionEpoch) return;
    ranEpoch.current = sessionEpoch;
    bootstrap();
  }, [bootstrap, sessionEpoch, paused]);

  return {
    bootstrapping,
    authed,
    setAuthed,
    stepUp,
    setStepUp,
    reloadSession,
    routeAfterAuth,
    handleLoggedIn,
    bootstrap,
  };
}
