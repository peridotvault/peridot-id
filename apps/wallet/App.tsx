import "./polyfills";
import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from "react-native";
import { Peridot } from "@peridotvault/pid-sdk-js";
import { API_BASE_URL, SOLANA_RPC_URL } from "./src/config";
import { AppContext } from "./src/AppContext";
import { theme } from "./src/theme";
import { LoginScreen } from "./src/screens/LoginScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SendScreen } from "./src/screens/SendScreen";
import { ReceiveScreen } from "./src/screens/ReceiveScreen";
import { SwapScreen } from "./src/screens/SwapScreen";
import { PasskeyScreen } from "./src/screens/PasskeyScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { SecurityScreen } from "./src/screens/SecurityScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ConnectedAccountsScreen } from "./src/screens/ConnectedAccountsScreen";
import { DangerZoneScreen } from "./src/screens/DangerZoneScreen";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import { ActivityDetailScreen } from "./src/screens/ActivityDetailScreen";
import { ActivationScreen } from "./src/screens/ActivationScreen";
import type { WalletTransaction } from "@peridotvault/pid-types";

const peridot = Peridot({ baseUrl: API_BASE_URL, solanaRpcUrl: SOLANA_RPC_URL });

type Screen =
  | "login"
  | "home"
  | "send"
  | "receive"
  | "swap"
  | "passkey"
  | "settings"
  | "profile"
  | "security"
  | "sessions"
  | "connected"
  | "danger"
  | "activity"
  | "activity-detail"
  | "activation";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [activityTx, setActivityTx] = useState<WalletTransaction | null>(null);
  const [passkeyReturn, setPasskeyReturn] = useState<Screen>("security");

  const goHome = useCallback(() => setScreen("home"), []);
  const goLogin = useCallback(() => setScreen("login"), []);
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
  const bootstrap = useCallback(async () => {
    try {
      const me = await peridot.identity.me();
      if (me && !("statusCode" in me)) setScreen("home");
    } catch {
      // not logged in — stay on login
    } finally {
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

  if (bootstrapping) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.foreground} />
      </SafeAreaView>
    );
  }

  return (
    <AppContext.Provider value={{ peridot }}>
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        {screen === "login" && <LoginScreen onLoggedIn={goHome} />}
        {screen === "home" && (
          <HomeScreen
            goSend={() => go("send")}
            goReceive={() => go("receive")}
            goSwap={() => go("swap")}
            goActivity={() => go("activity")}
            goActivityDetail={openActivityDetail}
            goActivation={() => go("activation")}
            goSettings={() => go("settings")}
            onLogout={logout}
          />
        )}
        {screen === "send" && <SendScreen onDone={goHome} />}
        {screen === "receive" && <ReceiveScreen onDone={goHome} />}
        {screen === "swap" && <SwapScreen onDone={goHome} />}
        {screen === "passkey" && <PasskeyScreen onDone={() => setScreen(passkeyReturn)} />}
        {screen === "activation" && <ActivationScreen onDone={goHome} goPasskey={() => openPasskey("activation")} />}
        {screen === "settings" && (
          <SettingsScreen
            goProfile={() => go("profile")}
            goSecurity={() => go("security")}
            goConnected={() => go("connected")}
            goDanger={() => go("danger")}
            onDone={goHome}
          />
        )}
        {screen === "profile" && <ProfileScreen onDone={() => go("settings")} />}
        {screen === "security" && (
          <SecurityScreen
            goPasskeys={() => openPasskey("security")}
            goSessions={() => go("sessions")}
            goConnected={() => go("connected")}
            onDone={() => go("settings")}
          />
        )}
        {screen === "sessions" && <SessionsScreen onDone={() => go("security")} />}
        {screen === "connected" && <ConnectedAccountsScreen onDone={() => go("security")} />}
        {screen === "danger" && <DangerZoneScreen onDone={() => go("settings")} onDeleted={goLogin} />}
        {screen === "activity" && <ActivityScreen onDone={goHome} onSelect={openActivityDetail} />}
        {screen === "activity-detail" && activityTx && <ActivityDetailScreen tx={activityTx} onDone={() => go("activity")} />}
        <StatusBar style="light" />
      </SafeAreaView>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});