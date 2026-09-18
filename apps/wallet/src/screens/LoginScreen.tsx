import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { postPopupResult, readPopupParams } from "@peridotvault/pid-sdk-js";
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
  // Popup login (`?popup=login&origin=…` opened by a dapp): results go back via
  // postMessage to the opener instead of navigation.
  const [popup] = useState(() => {
    const p = readPopupParams();
    return p && p.action === "login" ? p : null;
  });
  const autoStarted = useRef(false);
  // Post-auth PID creation: the handle becomes the permanent `<handle>@pid`
  // identity (never changeable, reused, or reassigned). The user must tick the
  // permanence acknowledgement before continuing.
  const [handle, setHandle] = useState("");
  const [handleStatus, setHandleStatus] = useState<"idle" | "checking" | "free" | "taken" | "invalid">("idle");
  const [ackPermanent, setAckPermanent] = useState(false);
  // Post-auth pending claim (verified credential, no identity yet). undefined =
  // still checking, null = none. The claim screen takes over when set.
  const [claim, setClaim] = useState<{ email: string | null; displayName: string | null } | null | undefined>(undefined);
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
            : (me as { pid: string }).pid;
        if (!cancelled) setSession({ label });
      } catch {
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sso, peridot]);

  /** Pending post-auth claim check (server is source of truth). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await peridot.auth.claimStatus();
        if (!cancelled) setClaim(st.pending ? { email: st.email ?? null, displayName: st.displayName ?? null } : null);
      } catch {
        if (!cancelled) setClaim(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peridot]);

  /** Retryable OAuth failure from the callback (?error=) — show inline, then strip. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = new URL(window.location.href).searchParams.get("error");
    if (!code) return;
    setError(
      code === "oauth_not_configured"
        ? "Sign-in is not available right now — please try again later."
        : "Google sign-in failed — please try again.",
    );
    const url = new URL(window.location.href);
    url.searchParams.delete("error");
    window.history.replaceState(null, "", url.toString());
  }, []);

  /** Live availability check for the PID claim input (server is source of truth). */
  useEffect(() => {
    const h = handle.trim().toLowerCase();
    if (!h) {
      setHandleStatus("idle");
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(h)) {
      setHandleStatus("invalid");
      return;
    }
    let cancelled = false;
    setHandleStatus("checking");
    const t = setTimeout(() => {
      peridot.auth
        .pidAvailable(h)
        .then((res) => {
          if (!cancelled) setHandleStatus(res.available ? "free" : "taken");
        })
        .catch(() => {
          if (!cancelled) setHandleStatus("idle");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, peridot]);

  /** In SSO mode, leave this page: the app exchanges the code for its own session. */
  const finishSso = (pidCode: string | undefined) => {
    if (sso && pidCode && typeof window !== "undefined") {
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
      return true;
    }
    return false;
  };

  /** Popup delivery: post the code to the opener instead of navigating. True when delivered. */
  const deliver = (pidCode: string): boolean => {
    if (!popup || typeof window === "undefined" || !window.opener) return false;
    postPopupResult(popup.origin, { ok: true, data: { pidCode } });
    return true;
  };

  const claimSignOut = async () => {
    setBusy(true);
    try {
      await peridot.auth.cancelClaim();
    } catch {
      // cancel must never trap the user — the ticket expires on its own
    } finally {
      setClaim(null);
      setHandle("");
      setAckPermanent(false);
      setError(null);
      setBusy(false);
    }
  };

  const claimPid = async () => {
    const h = handle.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.claim(h);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("claim");
        window.history.replaceState(null, "", url.toString());
      }
      // SSO claim: the ticket (server-validated) knows where to go back to.
      // Legacy fallback: SSO params on our own URL. Otherwise stay home.
      if (res.pidCode && res.redirectTo && typeof window !== "undefined") {
        window.location.assign(withPidCode(res.redirectTo, res.pidCode));
        return;
      }
      if (res.pidCode && deliver(res.pidCode)) return;
      if (finishSso(res.pidCode)) return;
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
      if (res.pidCode && deliver(res.pidCode)) return;
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
      // (= this wallet's origin) with the session cookie — or, for a new credential,
      // on the PID claim screen (the only place handles are chosen).
      // Never navigate on success here: the browser leaves for Google, and the
      // return bootstrap lands home. On failure (null/throw) stay on login.
      // Popup mode navigates too — the OAuth round-trip returns to the dapp URL
      // inside this popup, which forwards the code to the opener itself.
      const url = await peridot.auth.login(
        sso
          ? {
              ...(sso.redirectUri ? { returnTo: sso.redirectUri } : {}),
              ...(sso.clientId ? { clientId: sso.clientId } : {}),
            }
          : undefined,
      );
      if (!url) {
        setError("Couldn't reach Google — try again.");
        return;
      }
      if (typeof window !== "undefined") window.location.assign(url);
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
      if (deliver(pidCode)) return;
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const denyApp = () => {
    if (typeof window === "undefined") return;
    if (popup) {
      postPopupResult(popup.origin, { ok: false, error: "access_denied" });
      return;
    }
    if (!sso) return;
    window.location.assign(withDenied(sso.redirectUri));
  };

  // Popup opened from a method button: auto-start that method once the login
  // form is showing (not on the claim/consent screens).
  useEffect(() => {
    if (!popup?.method || autoStarted.current) return;
    if (claim !== null) return;
    if (sso && session !== null) return;
    autoStarted.current = true;
    if (popup.method === "passkey") void signInWithPasskey();
    else void continueWithGoogle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup, claim, sso, session]);

  // SSO check in flight: branded loader, so the login form never flashes
  // before the consent modal resolves.
  if (sso && session === undefined) {
    return <LoadingScreen />;
  }

  // Pending post-auth claim: the credential is verified but no identity exists
  // yet. Claiming creates it — this screen is the only way forward.
  if (claim === undefined) {
    return <LoadingScreen />;
  }

  if (claim) {
    return (
      <View style={styles.screen}>
        <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
        <View style={s.container}>
          <View style={styles.claimHeader}>
            <Pressable onPress={claimSignOut} disabled={busy} accessibilityLabel="Sign out and cancel PID creation">
              <Text style={styles.signOut}>Sign Out</Text>
            </Pressable>
          </View>
          <View style={styles.middle}>
            <View style={styles.masthead}>
              <Text style={styles.title}>Create your PID</Text>
              {(claim.email || claim.displayName) && (
                <Text style={styles.subtitle}>Continuing as {claim.displayName ?? claim.email}</Text>
              )}
            </View>
            {error && <Text style={s.error}>{error}</Text>}
            <View style={styles.stack}>
              <View style={styles.handleWrap}>
                <TextInput
                  style={[s.input, styles.handleInput]}
                  value={handle}
                  onChangeText={(t) => {
                    setHandle(t.toLowerCase());
                    setAckPermanent(false);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="username"
                  placeholderTextColor={theme.colors.mutedForeground}
                  editable={!busy}
                />
                <Text style={styles.suffixInside} pointerEvents="none">@pid</Text>
              </View>
              {handleStatus === "free" && <Text style={styles.free}>✓ {handle.trim().toLowerCase()}@pid is available</Text>}
              {handleStatus === "taken" && <Text style={s.error}>Taken — try another handle.</Text>}
              {handleStatus === "invalid" && handle.length > 0 && (
                <Text style={s.error}>3-20 chars: lowercase letters, numbers, underscore.</Text>
              )}
              <Pressable
                style={styles.ackRow}
                onPress={() => setAckPermanent((v) => !v)}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: ackPermanent }}
              >
                <View style={[styles.ackBox, ackPermanent && styles.ackBoxChecked]}>
                  {ackPermanent && <Text style={styles.ackTick}>✓</Text>}
                </View>
                <Text style={styles.warn}>
                  Your PID is permanent — it can never be changed, reused, or reassigned. Choose carefully.
                </Text>
              </Pressable>
              <UIButton
                title={busy ? "Creating…" : "Create & Continue"}
                onPress={claimPid}
                disabled={busy || handleStatus !== "free" || !ackPermanent}
                variant="primary"
              />
            </View>
          </View>
        </View>
      </View>
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
              onPress={() => continueWithGoogle()}
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
  claimHeader: { width: "100%", flexDirection: "row", justifyContent: "flex-end", alignItems: "center", paddingTop: 8 },
  signOut: { fontSize: 14, color: theme.colors.danger ?? theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  handleWrap: { position: "relative", flex: 1, justifyContent: "center" },
  handleInput: { flex: 1, paddingRight: 64 },
  suffixInside: {
    position: "absolute",
    right: 12,
    fontSize: 15,
    color: theme.colors.mutedForeground,
    fontFamily: "Geist_400Regular",
  },
  free: { fontSize: 12, color: theme.colors.success ?? theme.colors.foreground, fontFamily: "Geist_400Regular" },
  warn: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular", flex: 1 },
  ackRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  ackBox: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: theme.colors.mutedForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  ackBoxChecked: { borderColor: theme.colors.foreground },
  ackTick: { fontSize: 14, color: theme.colors.foreground, fontFamily: "Geist_400Regular" },
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