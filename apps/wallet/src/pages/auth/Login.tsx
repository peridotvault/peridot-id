import { useCallback, useEffect, useRef, useState } from "react";
import { usePeridot } from "../../shared/app/AppContext";
import { readLoginContext, type LoginContext } from "../../feat/auth/utils/popupLogin";
import { readSsoParams, ssoOrigin } from "../../feat/auth/utils/sso";
import { LoadingScreen } from "../../shared/components/shell/LoadingScreen";
import type { AccountMenuModel } from "../../shared/components/shell/AccountMenu";
import { SsoConsentModal } from "../../feat/auth/components/SsoConsentModal";
import { SigningScreen } from "../../feat/auth/components/SigningScreen";
import { useAppInfo } from "../../feat/auth/hooks/useAppInfo";
import { useProviderCatalog } from "../../feat/auth/hooks/useProviderCatalog";
import { useLoginSession } from "../../feat/auth/hooks/useLoginSession";
import { usePidClaim } from "../../feat/auth/hooks/usePidClaim";
import { useEmailSignIn } from "../../feat/auth/hooks/useEmailSignIn";
import { useSignInMethods } from "../../feat/auth/hooks/useSignInMethods";
import { useConsentActions } from "../../feat/auth/hooks/useConsentActions";
import { useHeaderProfile } from "../../shared/hooks/useHeaderProfile";
import { PidClaimForm } from "../../feat/auth/components/PidClaimForm";
import { EmailOtpForm } from "../../feat/auth/components/EmailOtpForm";
import { LoginOptions } from "../../feat/auth/components/LoginOptions";
import { readOAuthError, stripOAuthError } from "../../feat/auth/utils/parseOAuthError";

export function Login({
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
  // A `?popup=login` load carries BOTH an origin context and (when the app
  // passed `returnTo`) `redirect_uri`. The popup context wins: the result is
  // handed to the opener and this window closes — never a redirect to the dapp,
  // which would leave the opener waiting forever.
  const [sso] = useState(() => (loginContext ? null : readSsoParams()));
  // Auth-in-a-new-tab (`?popup=login&origin=…&client_id=…` opened by a dapp):
  // the tab authenticates (and creates a PID if the user has none), then mints a
  // pid_code and posts it to the opener instead of navigating.
  const [ctx, setCtx] = useState<LoginContext | null>(() => loginContext ?? readLoginContext());
  const autoStarted = useRef(false);
  // Auth-in-a-new-tab consent: a session that already existed at tab open must
  // not auto-issue — the user picks Allow / different account in the consent
  // modal. A session created by an explicit login in this tab (no session at
  // open, or after "different account") delivers without a second prompt.
  // `delivered` guards the double-mint (inline deliver + effect).
  const flags = useRef({ delivered: false, hadSessionAtOpen: null as boolean | null }).current;

  // Verified-partner badge (server-sourced trust signal, fail-closed to hidden).
  const appClientId = sso?.clientId ?? ctx?.clientId;
  // Origin the app is requesting from — the API only answers app-info when the
  // app owns it, so the name/logo can't be borrowed by another origin.
  const appOrigin = sso ? ssoOrigin(sso.redirectUri) : (ctx?.origin ?? null);
  const appInfo = useAppInfo(peridot, appClientId, appOrigin);
  const catalog = useProviderCatalog(peridot);
  const appVerified = appInfo?.isVerified ?? false;
  // App-scoped login switches (dashboard → Integrations). null = show all.
  const allowedMethods = appClientId ? appInfo?.loginMethods ?? null : null;

  // Terminal state for auth-in-a-new-tab: the code was delivered (or denied)
  // but window.close() didn't take, so this window is still open. Without it
  // the stale ctx renders the consent scrim again over a finished flow.
  const [finished, setFinished] = useState<{ denied: boolean; origin: string } | null>(null);
  const finishCtx = useCallback(
    (denied: boolean) => {
      setFinished({ denied, origin: ctx?.origin ?? "" });
      setCtx(null);
    },
    [ctx],
  );

  const claim = usePidClaim(peridot, { sso, ctx, flags, onLoggedIn, setBusy, setError });
  const emailSignIn = useEmailSignIn(peridot, {
    sso,
    ctx,
    flags,
    onLoggedIn,
    refreshClaim: claim.refreshClaim,
    setBusy,
    setError,
    onCtxDone: finishCtx,
  });
  const { session, setSession, showLogin, setShowLogin } = useLoginSession(peridot, { sso, ctx, flags, claim: claim.claim, onCtxDone: finishCtx });
  const consent = useConsentActions(peridot, { sso, ctx, flags, setSession, setShowLogin, setBusy, setError, onCtxDone: finishCtx });
  // Same avatar + level chip as the wallet topbar, so the consent header reads
  // as the signed-in identity rather than a second, anonymous one. Keyed by the
  // active pid: switching accounts must re-read the profile, not keep the old
  // avatar from the previous identity.
  const header = useHeaderProfile(session?.pid ?? "");
  // Consent card's profile popover: same menu as the shell topbar, backed by the
  // consent hook so switching here keeps the pending request alive.
  const accountMenu: AccountMenuModel = {
    open: consent.picker !== null,
    accounts: consent.picker ?? [],
    busy,
    error: consent.pickerError,
    openMenu: () => void consent.openAccounts(),
    closeMenu: () => consent.setPicker(null),
    select: (pid) => void consent.pickAccount(pid),
    add: consent.addAccountCtx,
  };
  const signIn = useSignInMethods(peridot, {
    sso,
    ctx,
    flags,
    onLoggedIn,
    setBusy,
    setError,
    onCtxDone: finishCtx,
    refreshClaim: claim.refreshClaim,
  });

  /** Retryable OAuth failure from the callback (?error=) — show inline, then strip. */
  useEffect(() => {
    const code = readOAuthError();
    if (!code) return;
    setError(
      code === "oauth_not_configured"
        ? "Sign-in is not available right now — please try again later."
        : code === "login_method_disabled"
          ? "This app has turned off Google sign-in — use another method."
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
        origin={appOrigin}
        appName={appInfo?.name}
        logoUrl={appInfo?.logoUrl}
        description={appInfo?.description}
        verified={appVerified}
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

  // Code minted, redirect in flight: the signing animation replaces the card.
  if (consent.signing) {
    return <SigningScreen origin={appOrigin ?? ""} appName={appInfo?.name} logoUrl={appInfo?.logoUrl} pending />;
  }

  // Delivered/denied but still open: terminal screen, never the consent card.
  if (finished) {
    return (
      <SigningScreen
        origin={finished.origin}
        appName={appInfo?.name}
        logoUrl={appInfo?.logoUrl}
        denied={finished.denied}
      />
    );
  }

  // Already logged in + a pending request: one tap of consent, no redundant
  // login. Third-party SSO (`?redirect_uri=`) and auth-in-a-new-tab
  // (`?popup=login`) are the same card — only the allow handler differs, so
  // there is one consent screen, not one per entry point.
  if ((sso || ctx) && session && !showLogin) {
    return (
      <SsoConsentModal
        origin={appOrigin ?? ""}
        appName={appInfo?.name}
        logoUrl={appInfo?.logoUrl}
        description={appInfo?.description}
        sessionLabel={session.label}
        avatarUrl={header.avatarUrl}
        level={header.level}
        busy={busy}
        error={error}
        onAllow={sso ? consent.allowApp : consent.allowCtx}
        onDeny={consent.denyApp}
        verified={appVerified}
        accountMenu={accountMenu}
      />
    );
  }

  // Email OTP: address is entered inline on LoginOptions (arrow submit);
  // a sent code flips `step` to "code" and swaps in the OTP screen.
  if (emailSignIn.step === "code") {
    return (
      <EmailOtpForm
        step={emailSignIn.step}
        origin={appOrigin}
        appName={appInfo?.name}
        logoUrl={appInfo?.logoUrl}
        description={appInfo?.description}
        verified={appVerified}
        email={emailSignIn.email}
        code={emailSignIn.code}
        resendIn={emailSignIn.resendIn}
        busy={busy}
        error={error}
        onEmail={emailSignIn.setEmail}
        onCode={emailSignIn.setCode}
        onStart={() => emailSignIn.start()}
        onVerify={() => emailSignIn.verify()}
        onBack={() => {
          emailSignIn.reset();
          setError(null);
        }}
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
      appName={appInfo?.name}
      logoUrl={appInfo?.logoUrl}
      description={appInfo?.description}
      verified={appVerified}
      allowedMethods={allowedMethods}
      catalog={catalog}
      email={emailSignIn.email}
      onGoogle={() => signIn.continueWithGoogle()}
      onEmailChange={(t) => {
        if (error) setError(null);
        emailSignIn.setEmail(t);
      }}
      onSubmitEmail={() => emailSignIn.start()}
      onPasskey={signIn.signInWithPasskey}
      onWallet={signIn.signInWithWallet}
    />
  );
}
