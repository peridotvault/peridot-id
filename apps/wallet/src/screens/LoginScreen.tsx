import { useEffect, useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { usePeridot } from "../AppContext";
import { readSsoParams, ssoOrigin, withDenied, withPidCode } from "../sso";
import { theme, styles as s } from "../theme";
import { AsciiRidges } from "../components/AsciiRidges";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
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
          if (await peridot.auth.refresh()) me = await peridot.identity.me();
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
      // Google always leaves the page (OAuth redirect). Always pass returnTo so the
      // callback returns here with a pid_code instead of CLIENT_SUCCESS_URL —
      // loopback targets need no registration (SsoService.isLoopbackReturnTo).
      const returnTo =
        sso?.redirectUri ?? (typeof window !== "undefined" ? window.location.origin : undefined);
      await peridot.auth.login({
        ...(returnTo ? { returnTo } : {}),
        ...(sso?.clientId ? { clientId: sso.clientId } : {}),
      });
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

  // Already logged in + third-party SSO request: one-tap consent, no redundant login.
  if (sso && session && !showLogin) {
    return (
      <View style={styles.screen}>
        <AsciiRidges />
        <View style={s.container}>
          <View style={styles.hero}>
            <Text style={styles.title}>PeridotID</Text>
            <Text style={styles.subtitle}>Allow {ssoOrigin(sso.redirectUri)} to sign in with your PeridotID?</Text>
            <Text style={styles.hint}>Signed in as {session.label}. The app receives your ID, display name and email — never your passkeys.</Text>
          </View>
          {error && <Text style={s.error}>{error}</Text>}
          <Button title={busy ? "Authorizing…" : "Allow"} onPress={allowApp} disabled={busy} />
          <Button title="Use a different account" onPress={() => setShowLogin(true)} disabled={busy} />
          <Button title="Deny" onPress={denyApp} disabled={busy} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AsciiRidges />
      <View style={s.container}>
        <View style={styles.hero}>
          <Text style={styles.title}>PeridotID</Text>
          <Text style={styles.subtitle}>{sso ? `Sign in to continue to ${ssoOrigin(sso.redirectUri)}` : "Gaming identity wallet"}</Text>
          {!sso && (
            <Text style={styles.hint}>
              Sign in with a passkey on this device. Google is a recovery fallback — Google login
              alone does not create your on-chain wallet.
            </Text>
          )}
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <Button title={busy ? "Waiting for passkey…" : "Sign in with Passkey"} onPress={signInWithPasskey} disabled={busy} />
        <Button title="Continue with Google" onPress={continueWithGoogle} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  title: { fontSize: 36, fontWeight: "700", color: theme.colors.foreground, fontFamily: "serif" },
  subtitle: { fontSize: 15, color: theme.colors.mutedForeground },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, textAlign: "center", maxWidth: 300 },
});