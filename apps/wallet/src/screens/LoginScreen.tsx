import { useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

/**
 * Third-party SSO mode: when the page is opened as
 * `...?redirect_uri=https://app.example/callback&client_id=pidapp_...`, a successful
 * sign-in returns to the app with `?pid_code=...` instead of entering the wallet.
 * `client_id` is optional (unbound codes then follow the global allowlist), but
 * `redirect_uri` is required — without it there is nowhere to return to, and the
 * page behaves as the normal wallet login.
 * (Web only — passkey ceremonies must run on this PeridotID origin.)
 */
function readSsoParams(): { clientId?: string; redirectUri: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const clientId = params.get("client_id") ?? undefined;
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!redirectUri) return null;
    const parsed = new URL(redirectUri);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return { clientId, redirectUri };
  } catch {
    return null;
  }
}

function withPidCode(redirectUri: string, pidCode: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("pid_code", pidCode);
  return url.toString();
}

function ssoOrigin(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { peridot } = usePeridot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sso] = useState(readSsoParams);

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
      // Google always leaves the page (OAuth redirect); the API returns to redirect_uri
      // with a pid_code when one is requested, else to the wallet via CLIENT_SUCCESS_URL.
      await peridot.auth.login(sso ? { returnTo: sso.redirectUri, clientId: sso.clientId } : undefined);
      onLoggedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
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
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  title: { fontSize: 36, fontWeight: "700", color: theme.colors.foreground, fontFamily: "serif" },
  subtitle: { fontSize: 15, color: theme.colors.mutedForeground },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, textAlign: "center", maxWidth: 300 },
});