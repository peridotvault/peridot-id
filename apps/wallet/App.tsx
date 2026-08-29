import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from "react-native";
import { Peridot } from "@peridot/sdk-js";
import { API_BASE_URL, SOLANA_RPC_URL } from "./src/config";
import { AppContext } from "./src/AppContext";
import { LoginScreen } from "./src/screens/LoginScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { TopupScreen } from "./src/screens/TopupScreen";
import { WithdrawScreen } from "./src/screens/WithdrawScreen";
import { PasskeyScreen } from "./src/screens/PasskeyScreen";

const peridot = Peridot({ baseUrl: API_BASE_URL, solanaRpcUrl: SOLANA_RPC_URL });

type Screen = "login" | "home" | "topup" | "withdraw" | "passkey";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [bootstrapping, setBootstrapping] = useState(true);

  // After an OAuth redirect returns, detect the existing session and go straight home.
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

  if (bootstrapping) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  return (
    <AppContext.Provider value={{ peridot }}>
      <SafeAreaView style={styles.safe}>
        {screen === "login" && <LoginScreen onLoggedIn={() => setScreen("home")} />}
        {screen === "home" && (
          <HomeScreen
            goTopup={() => setScreen("topup")}
            goWithdraw={() => setScreen("withdraw")}
            goPasskey={() => setScreen("passkey")}
            onLogout={() => setScreen("login")}
          />
        )}
        {screen === "topup" && <TopupScreen onDone={() => setScreen("home")} />}
        {screen === "withdraw" && <WithdrawScreen onDone={() => setScreen("home")} />}
        {screen === "passkey" && <PasskeyScreen onDone={() => setScreen("home")} />}
        <StatusBar style="auto" />
      </SafeAreaView>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});