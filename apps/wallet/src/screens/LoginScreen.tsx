import { useEffect, useRef, useState } from "react";
import { usePeridot } from "../shared/AppContext";
import { readLoginContext, type LoginContext } from "../feat/auth/popup-login";
import { readSsoParams, ssoOrigin } from "../feat/auth/sso";
import { LoadingScreen } from "../shared/components/LoadingScreen";
import { AccountSwitcherModal } from "../shared/components/AccountSwitcherModal";
import { SsoConsentModal } from "../feat/auth/components/SsoConsentModal";
import { useAppVerified } from "../feat/auth/hooks/useAppVerified";
import { useLoginSession } from "../feat/auth/hooks/useLoginSession";
import { usePidClaim } from "../feat/auth/hooks/usePidClaim";
import { useSignInMethods } from "../feat/auth/hooks/useSignInMethods";
import { useConsentActions } from "../feat/auth/hooks/useConsentActions";
import { PidClaimForm } from "../feat/auth/components/PidClaimForm";
import { LoginOptions } from "../feat/auth/components/LoginOptions";
import { readOAuthError, stripOAuthError } from "../feat/auth/utils/parseOAuthError";

export function LoginScreen({
  onLoggedIn,
  stepUp,
  loginContext,
}: {
  onLoggedIn: () => void;
  stepUp?: boolean;
  loginContext?: LoginContext | null;
}) {
  const { peridot } = usePeridot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sso] = useState(readSsoParams);
  // Auth-in-a-new-tab (`?popup=login&origin=…&client_id=…` opened by a dapp):
  // the tab authenticates (and creates a PID if the user has none), then mints a
  // pid_code and posts it to the opener instead of navigating.
  const [ctx] = useState<LoginContext | null>(() => loginContext ?? readLoginContext());
  const autoStarted = useRef(false);
  // Auth-in-a-new-tab consent: a session that already existed at tab open must
  // not auto-issue — the user picks Allow / different account in the consent
  // modal. A session created by an explicit login in this tab (no session at
  // open, or after "different account") delivers without a second prompt.
  // `delivered` guards the double-mint (inline deliver + effect).
  const flags = useRef({ delivered: false, hadSessionAtOpen: null as boolean | null }).current;

  // Verified-partner badge (server-sourced trust signal, fail-closed to hidden).
  const appClientId = sso?.clientId ?? ctx?.clientId;
  const appVerified = useAppVerified(peridot, appClientId);

  const claim = usePidClaim(peridot, { sso, ctx, flags, onLoggedIn, setBusy, setError });
  const { session, setSession, showLogin, setShowLogin } = useLoginSession(peridot, { sso, ctx, flags, claim: claim.claim });
  const consent = useConsentActions(peridot, { sso, ctx, flags, setSession, setShowLogin, setBusy, setError });
  const signIn = useSignInMethods(peridot, { sso, ctx, flags, onLoggedIn, setBusy, setError });

  /** Retryable OAuth failure from the callback (?error=) — show inline, then strip. */
  useEffect(() => {
    const code = readOAuthError();
    if (!code) return;
    setError(
      code === "oauth_not_configured"
        ? "Sign-in is not available right now — please try again later."
        : "Google sign-in failed — please try again.",
    );
    stripOAuthError();
  }, []);

  // Popup opened from a method button: auto-start that method once the login
  // form is showing (not on the claim/consent screens).
  useEffect(() => {
    if (!ctx?.method || autoStarted.current) return;
    if (claim.claim !== null) return;
    if ((sso || ctx) && session !== null) return;
    autoStarted.current = true;
    if (ctx.method === "passkey") void signIn.signInWithPasskey();
    else void signIn.continueWithGoogle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, claim.claim, sso, session]);

  // SSO check in flight: branded loader, so the login form never flashes
  // before the consent modal resolves.
  if ((sso || ctx) && session === undefined) {
    return <LoadingScreen />;
  }

  // Pending post-auth claim: the credential is verified but no identity exists
  // yet. Claiming creates it — this screen is the only way forward.
  if (claim.claim === undefined) {
    return <LoadingScreen />;
  }

  if (claim.claim) {
    return (
      <PidClaimForm
        email={claim.claim.email}
        displayName={claim.claim.displayName}
        handle={claim.handle}
        handleStatus={claim.handleStatus}
        ackPermanent={claim.ackPermanent}
        busy={busy}
        error={error}
        onHandle={claim.setHandle}
        onAck={() => claim.setAckPermanent((v) => !v)}
        onSubmit={claim.claimPid}
        onSignOut={claim.claimSignOut}
      />
    );
  }

  // Already logged in + third-party SSO request: one-tap consent, no redundant login.
  if (sso && session && !showLogin) {
    return (
      <SsoConsentModal
        origin={ssoOrigin(sso.redirectUri)}
        sessionLabel={session.label}
        busy={busy}
        error={error}
        onAllow={consent.allowApp}
        onDifferent={() => setShowLogin(true)}
        onDeny={consent.denyApp}
        verified={appVerified}
      />
    );
  }

  // Auth-in-a-new-tab + pre-existing session: explicit consent, same card as SSO.
  if (ctx && session && !showLogin && claim.claim === null) {
    if (consent.picker !== null) {
      return (
        <AccountSwitcherModal
          visible
          accounts={consent.picker}
          busy={busy}
          error={consent.pickerError}
          onClose={() => consent.setPicker(null)}
          onSelect={consent.pickAccount}
          onAdd={consent.addAccountCtx}
        />
      );
    }
    return (
      <SsoConsentModal
        origin={ctx.origin}
        sessionLabel={session.label}
        busy={busy}
        error={error}
        onAllow={consent.allowCtx}
        onDifferent={consent.useDifferentCtx}
        onDeny={consent.denyApp}
        verified={appVerified}
      />
    );
  }

  return (
    <LoginOptions
      busy={busy}
      error={error}
      stepUp={!!stepUp}
      ssoOrigin={sso ? ssoOrigin(sso.redirectUri) : null}
      ctxOrigin={ctx?.origin ?? null}
      onGoogle={() => signIn.continueWithGoogle()}
      onPasskey={signIn.signInWithPasskey}
    />
  );
}
