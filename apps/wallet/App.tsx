import "./polyfills";
import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { useFonts, Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { SourceSerif4_400Regular } from "@expo-google-fonts/source-serif-4";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { Peridot } from "@peridotvault/pid-sdk-js";
import { API_BASE_URL, SOLANA_RPC_URL } from "./src/config";
import { AppContext } from "./src/AppContext";
import { theme } from "./src/theme";
import { LoginScreen } from "./src/screens/LoginScreen";
import { LoadingScreen } from "./src/components/LoadingScreen";
import { readSsoParams } from "./src/sso";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SendScreen } from "./src/screens/SendScreen";
import { ReceiveScreen } from "./src/screens/ReceiveScreen";
import { SwapScreen } from "./src/screens/SwapScreen";
import { ItemsScreen } from "./src/screens/ItemsScreen";
import { PasskeyScreen } from "./src/screens/PasskeyScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { EditProfileScreen } from "./src/screens/EditProfileScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ConnectedAccountsScreen } from "./src/screens/ConnectedAccountsScreen";
import { AppConnectionsScreen } from "./src/screens/AppConnectionsScreen";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import { ActivityDetailScreen } from "./src/screens/ActivityDetailScreen";
import { TabBar } from "./src/components/TabBar";
import { ActivationScreen } from "./src/screens/ActivationScreen";
import type { WalletTransaction } from "@peridotvault/pid-types";

const peridot = Peridot({ baseUrl: API_BASE_URL, solanaRpcUrl: SOLANA_RPC_URL });

type Screen =
  | "login"
  | "home"
  | "send"
  | "receive"
  | "swap"
  | "items"
  | "passkey"
  | "settings"
  | "profile"
  | "edit-profile"
  | "sessions"
  | "connected"
  | "app-connections"
  | "activity"
  | "activity-detail"
  | "activation";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [bootstrapping, setBootstrapping] = useState(true);
  // True when the session family aged out (google families: 7 days) — the
  // login screen then asks for passkey confirmation instead of silently dying.
  const [stepUp, setStepUp] = useState(false);
  // Web type system (Geist + Source Serif 4, same as apps/web). Bundled via
  // expo-font so it works offline on web + native; splash holds until loaded.
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    SourceSerif4_400Regular,
    JetBrainsMono_400Regular,
  });
  // Third-party SSO request (?redirect_uri=…): LoginScreen handles it even when logged
  // in (consent flow) — otherwise a logged-in user landing here would sit on HomeScreen
  // with the request silently ignored.
  const [ssoRequest] = useState(readSsoParams);
  const [activityTx, setActivityTx] = useState<WalletTransaction | null>(null);
  const [passkeyReturn, setPasskeyReturn] = useState<Screen>("settings");

  const goHome = useCallback(() => setScreen("home"), []);
  const go = useCallback((s: Screen) => setScreen(s), []);

  const openPasskey = useCallback((from: Screen) => {
    setPasskeyReturn(from);
    setScreen("passkey");
  }, []);

  const openActivityDetail = useCallback((tx: WalletTransaction) => {
    setActivityTx(tx);
    setScreen("activity-detail");
  }, []);

  // After a Google OAuth redirect returns, detect the existing session and go straight home.
  // Short-lived access tokens are revived via the refresh cookie first, so a
  // valid session survives app restarts instead of bouncing to login.
  const bootstrap = useCallback(async () => {
    try {
      let me = await peridot.identity.me();
      if (typeof me === "object" && me !== null && "statusCode" in me) {
        const refreshed = await peridot.auth.refresh();
        if (refreshed === "step-up") {
          setStepUp(true);
        } else if (refreshed === true) {
          me = await peridot.identity.me();
        }
      }
      if (me && !("statusCode" in me)) setScreen("home");
    } catch {
      // not logged in — stay on login
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
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const logout = useCallback(async () => {
    try {
      await peridot.auth.logout();
    } catch {
      // best-effort: still clear the UI session even if the server call fails
    } finally {
      setScreen("login");
    }
  }, []);

  // Paint first, complete later: the branded loader shows instantly (system
  // fallbacks) while fonts download and the session check runs in parallel.
  if (bootstrapping || !fontsLoaded) {
    return <LoadingScreen fontsReady={fontsLoaded} />;
  }

  return (
    <AppContext.Provider value={{ peridot }}>
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        {(screen === "login" || ssoRequest) && (
          <LoginScreen
            onLoggedIn={() => {
              setStepUp(false);
              goHome();
            }}
            stepUp={stepUp}
          />
        )}
        {screen === "home" && (
          <HomeScreen
            goSend={() => go("send")}
            goReceive={() => go("receive")}
            goSwap={() => go("swap")}
            goItems={() => go("items")}
            goActivation={() => go("activation")}
            goPasskeys={() => openPasskey("settings")}
            goAppConnections={() => go("app-connections")}
          />
        )}
        {screen === "send" && <SendScreen onDone={goHome} />}
        {screen === "receive" && <ReceiveScreen onDone={goHome} />}
        {screen === "swap" && <SwapScreen onDone={goHome} />}
        {screen === "items" && <ItemsScreen onDone={goHome} />}
        {screen === "passkey" && <PasskeyScreen onDone={() => setScreen(passkeyReturn)} />}
        {screen === "activation" && <ActivationScreen onDone={goHome} goPasskey={() => openPasskey("activation")} />}
        {screen === "settings" && (
          <SettingsScreen
            goPasskeys={() => openPasskey("settings")}
            goSessions={() => go("sessions")}
            goConnected={() => go("connected")}
            onDone={() => go("profile")}
          />
        )}
        {screen === "profile" && (
          <ProfileScreen
            onLogout={logout}
            goSettings={() => go("settings")}
            goEditProfile={() => go("edit-profile")}
          />
        )}
        {screen === "edit-profile" && <EditProfileScreen onDone={() => go("profile")} />}
        {screen === "sessions" && <SessionsScreen onDone={() => go("settings")} />}
        {screen === "connected" && <ConnectedAccountsScreen onDone={() => go("settings")} />}
        {screen === "app-connections" && <AppConnectionsScreen onDone={goHome} />}
        {screen === "activity" && <ActivityScreen onSelect={openActivityDetail} />}
        {screen === "activity-detail" && activityTx && <ActivityDetailScreen tx={activityTx} onDone={() => go("activity")} />}
        {(screen === "home" || screen === "activity" || screen === "profile") && (
          <TabBar current={screen} go={go} />
        )}
        <StatusBar style="light" />
      </SafeAreaView>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
});