import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { usePeridot } from "../AppContext";
import { readSsoParams, ssoOrigin, withDenied, withPidCode } from "../sso";
import { theme, styles as s } from "../theme";
import { AsciiRidges } from "../components/AsciiRidges";
import { LoadingScreen } from "../components/LoadingScreen";
import { SsoConsentModal } from "../components/SsoConsentModal";
import { UIButton } from "../components/UIButton";

export function LoginScreen({ onLoggedIn, stepUp }: { onLoggedIn: () => void; stepUp?: boolean }) {
  const { peridot } = usePeridot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sso] = useState(readSsoParams);
  // Existing wallet session, if any (SSO mode only): offers one-tap Allow instead
  // of forcing a redundant login. undefined = still checking, null = none.
  const [session, setSession] = useState<{ label: string } | null | undefined>(sso ? undefined : null);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    if (!sso || typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        // Access tokens are short-lived; a live refresh cookie revives the session
        // without forcing a redundant login.
        let me = await peridot.identity.me();
        if (typeof me === "object" && me !== null && "statusCode" in me) {
          if ((await peridot.auth.refresh()) === true) me = await peridot.identity.me();
        }
        if (cancelled || typeof me !== "object" || me === null || "statusCode" in me) {
          if (!cancelled) setSession(null);
          return;
        }
        const profile = await peridot.profile.me();
        const label =
          typeof profile === "object" && profile !== null && !("statusCode" in profile) && profile.displayName
            ? profile.displayName
            : (me as { id: string }).id;
        if (!cancelled) setSession({ label });
      } catch {
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sso, peridot]);

  /** In SSO mode, leave this page: the app exchanges the code for its own session. */
  const finishSso = (pidCode: string | undefined) => {
    if (sso && pidCode && typeof window !== "undefined") {
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
      return true;
    }
    return false;
  };

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.loginWithPasskey(
        sso ? { returnTo: sso.redirectUri, clientId: sso.clientId } : undefined,
      );
      if (!res.ok) {
        setError("Sign-in was cancelled — try again.");
        return;
      }
      if (finishSso(res.pidCode)) return;
      onLoggedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const continueWithGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      // Google always leaves the page (OAuth redirect). Only cross-origin SSO requests
      // carry a returnTo (an allowlisted third-party origin). A first-party login omits
      // it: window.location.origin here (app.pid.peridotvault.com) is NOT in the server's
      // returnTo allowlist, so sending it 400s (localhost only "worked" because loopback
      // URLs are exempt). Without returnTo the Google callback lands on CLIENT_SUCCESS_URL
      // (= this wallet's origin) with the session cookie.
      await peridot.auth.login(
        sso
          ? {
              ...(sso.redirectUri ? { returnTo: sso.redirectUri } : {}),
              ...(sso.clientId ? { clientId: sso.clientId } : {}),
            }
          : undefined,
      );
      onLoggedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const allowApp = async () => {
    if (!sso) return;
    setBusy(true);
    setError(null);
    try {
      // Mint a code for the CURRENT session — no re-authentication needed.
      const { pidCode } = await peridot.auth.authorize({ returnTo: sso.redirectUri, clientId: sso.clientId });
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const denyApp = () => {
    if (!sso || typeof window === "undefined") return;
    window.location.assign(withDenied(sso.redirectUri));
  };

  // SSO check in flight: branded loader, so the login form never flashes
  // before the consent modal resolves.
  if (sso && session === undefined) {
    return <LoadingScreen />;
  }

  // Already logged in + third-party SSO request: one-tap consent, no redundant login.
  if (sso && session && !showLogin) {
    return (
      <SsoConsentModal
        origin={ssoOrigin(sso.redirectUri)}
        sessionLabel={session.label}
        busy={busy}
        error={error}
        onAllow={allowApp}
        onDifferent={() => setShowLogin(true)}
        onDeny={denyApp}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
        <View style={styles.middle}>
          <View style={styles.masthead}>
            <Text style={styles.title}>PeridotID</Text>
            {sso ? <Text style={styles.subtitle}>Sign in to continue to {ssoOrigin(sso.redirectUri)}</Text> : null}
          </View>
          {error && <Text style={s.error}>{error}</Text>}
          <View style={styles.stack}>
            <UIButton
              title="Continue with Google"
              onPress={continueWithGoogle}
              disabled={busy}
              icon={<FontAwesome name="google" size={16} color={theme.colors.foreground} />}
            />
            <UIButton
              title="Continue with Apple"
              note="Coming soon"
              disabled
              icon={<FontAwesome name="apple" size={18} color={theme.colors.mutedForeground} />}
            />
            <View style={styles.orRow}>
              <View style={styles.hairline} />
              <Text style={styles.orText}>or</Text>
              <View style={styles.hairline} />
            </View>
            {stepUp && (
              <Text style={styles.stepUp}>Session expired — please confirm it's you with your passkey.</Text>
            )}
            <UIButton
              title={busy ? "Waiting for passkey…" : "Select a passkey"}
              onPress={signInWithPasskey}
              disabled={busy}
              variant="primary"
            />
            <Text style={styles.legal}>By continuing, I agree to PeridotID Terms of Use and Privacy notice</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: {
    fontSize: 40,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, textAlign: "center", maxWidth: 300 },
  middle: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center", gap: 20 },
  masthead: { alignItems: "center", gap: 8 },
  stack: { width: "100%", maxWidth: 343, gap: 12 },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  hairline: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  orText: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  stepUp: {
    fontSize: 13,
    color: theme.colors.foreground,
    textAlign: "center",
    fontFamily: "Geist_400Regular",
  },
  legal: {
    fontSize: 11,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    fontFamily: "Geist_400Regular",
  },
});