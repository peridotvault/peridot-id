import "./polyfills";
import { useCallback, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { Peridot, BrowserPasskeySigner } from "@peridotvault/pid-sdk-js";
import { readPopupParams } from "@peridotvault/pid-sdk-js";
import { API_BASE_URL } from "./src/shared/config";
import { AppContext } from "./src/shared/AppContext";
import { readLoginContext } from "./src/feat/auth/popup-login";
import { theme } from "./src/shared/theme";
import { useStartupGate } from "./src/shared/hooks/useStartupGate";
import { useSessionBootstrap, type Screen } from "./src/shared/hooks/useSessionBootstrap";
import { useSessionSync } from "./src/shared/hooks/useSessionSync";
import { LoginScreen } from "./src/screens/LoginScreen";
import { LoadingScreen } from "./src/shared/components/LoadingScreen";
import { readSsoParams } from "./src/feat/auth/sso";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ApproveScreen } from "./src/screens/ApproveScreen";
import { SendScreen } from "./src/screens/SendScreen";
import { ReceiveScreen } from "./src/screens/ReceiveScreen";
import { SwapScreen } from "./src/screens/SwapScreen";
import { TopupScreen } from "./src/screens/TopupScreen";
import { ProvisioningScreen } from "./src/screens/ProvisioningScreen";
import { PasskeyScreen } from "./src/screens/PasskeyScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ProfileScreen } from "./src/screens/ProfileScreen";
import { EditProfileScreen } from "./src/screens/EditProfileScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ConnectedAccountsScreen } from "./src/screens/ConnectedAccountsScreen";
import { AppConnectionsScreen } from "./src/screens/AppConnectionsScreen";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import { ActivityDetailScreen } from "./src/screens/ActivityDetailScreen";
import { FiatDetailScreen } from "./src/screens/FiatDetailScreen";
import { FiatTransferScreen } from "./src/screens/FiatTransferScreen";
import { FiatLedgerDetailScreen } from "./src/screens/FiatLedgerDetailScreen";
import { TabBar } from "./src/shared/components/TabBar";
import { ActivationScreen } from "./src/screens/ActivationScreen";
import type { WalletTransaction } from "@peridotvault/pid-types";
import type { FiatItem, FiatLedgerItem } from "./src/shared/fiat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  // Third-party SSO request (?redirect_uri=…): LoginScreen handles it even when logged
  // in (consent flow) — otherwise a logged-in user landing here would sit on HomeScreen
  // with the request silently ignored.
  const [ssoRequest] = useState(readSsoParams);
  // Auth-in-a-new-tab (`?popup=login&origin=…&client_id=…`): the tab stays on
  // the login screen to authenticate (and create a PID if missing), then mints a
  // pid_code for the opener. Survives the OAuth round-trip via sessionStorage.
  const [loginContext] = useState(readLoginContext);
  // Popup sign request (`?popup=<action>&origin=…` opened by a dapp): the
  // approval screen takes over the whole app — never the normal wallet flow.
  // (`?popup=login` stays on the normal flow; LoginScreen delivers via popup.)
  const [popupRequest] = useState(() => {
    const p = readPopupParams();
    return p && p.action !== "login" ? p : null;
  });

  // Built in-state (not module scope): any 401 outside /v1/auth/* kicks back
  // to login instead of stranding the app on a dead session. Idempotent —
  // the login screen makes no auto-auth calls outside SSO, so no loops.
  const [peridot] = useState(() =>
    Peridot({
      baseUrl: API_BASE_URL,
      // Chains/RPC resolved from the API registry.
      // First-party origin: inline ceremonies are legitimate here (this IS the
      // trusted DOM). Third-party dapps omit the signer and use the popup.
      passkeySigner: new BrowserPasskeySigner(),
      onUnauthorized: () => {
        session.setStepUp(false);
        setScreen("login");
      },
    }),
  );
  const session = useSessionBootstrap(peridot, { loginContext, setScreen });
  const gate = useStartupGate();
  useSessionSync({
    bootstrap: session.bootstrap,
    disabled: !!popupRequest || !!loginContext,
    isAuthed: session.authed,
  });

  const [activityTx, setActivityTx] = useState<WalletTransaction | null>(null);
  const [fiatItem, setFiatItem] = useState<FiatItem | null>(null);
  const [ledgerItem, setLedgerItem] = useState<FiatLedgerItem | null>(null);
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

  const openFiatDetail = useCallback((item: FiatItem) => {
    setFiatItem(item);
    setScreen("fiat-detail");
  }, []);

  const openLedgerDetail = useCallback((item: FiatLedgerItem) => {
    setLedgerItem(item);
    setScreen("fiat-ledger-detail");
  }, []);

  const logout = useCallback(async () => {
    try {
      await peridot.auth.logout();
    } catch {
      // best-effort: still clear the UI session even if the server call fails
    } finally {
      session.setAuthed(false);
      setScreen("login");
    }
  }, [peridot, session]);

  // Paint first, complete later: the branded loader shows instantly (system
  // fallbacks) while fonts download and the session check runs in parallel.
  // fontError skips the font wait; gateForced opens after 8s no matter what.
  if ((session.bootstrapping || (!gate.fontsLoaded && !gate.fontError)) && !gate.gateForced) {
    return <LoadingScreen fontsReady={gate.fontsLoaded} />;
  }

  return (
    <AppContext.Provider value={{ peridot }}>
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
        {popupRequest ? (
          session.authed ? (
            <ApproveScreen popup={popupRequest} onNeedAuth={() => session.setAuthed(false)} />
          ) : (
            // No session in this popup window: sign in here first, then the
            // approval resumes (popup params are persisted across the OAuth
            // round-trip by readPopupParams).
            <LoginScreen onLoggedIn={() => session.setAuthed(true)} stepUp={session.stepUp} />
          )
        ) : (
          <>
            {(screen === "login" || ssoRequest) && (
          <LoginScreen
            onLoggedIn={loginContext ? () => {} : session.handleLoggedIn}
            loginContext={loginContext}
            stepUp={session.stepUp}
          />
        )}
        {screen === "home" && (
          <HomeScreen
            goSend={() => go("send")}
            goReceive={() => go("receive")}
            goSwap={() => go("swap")}
            goBuy={() => go("topup")}
            goTransfer={() => go("fiat-transfer")}
            goPasskeys={() => openPasskey("settings")}
            goAppConnections={() => go("app-connections")}
          />
        )}
        {screen === "send" && <SendScreen onDone={goHome} />}
        {screen === "fiat-transfer" && <FiatTransferScreen onDone={goHome} />}
        {screen === "receive" && <ReceiveScreen onDone={goHome} goPasskey={() => openPasskey("receive")} />}
        {screen === "swap" && <SwapScreen onDone={goHome} />}
        {screen === "topup" && <TopupScreen onDone={goHome} />}
        {screen === "provisioning" && <ProvisioningScreen onContinue={goHome} />}
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
            onSwitched={session.reloadSession}
            onAddAccount={() => setScreen("login")}
          />
        )}
        {screen === "edit-profile" && <EditProfileScreen onDone={() => go("profile")} />}
        {screen === "sessions" && <SessionsScreen onDone={() => go("settings")} />}
        {screen === "connected" && <ConnectedAccountsScreen onDone={() => go("settings")} />}
        {screen === "app-connections" && <AppConnectionsScreen onDone={goHome} />}
        {screen === "activity" && <ActivityScreen onSelect={openActivityDetail} onSelectFiat={openFiatDetail} onSelectLedger={openLedgerDetail} />}
        {screen === "activity-detail" && activityTx && <ActivityDetailScreen tx={activityTx} onDone={() => go("activity")} />}
        {screen === "fiat-detail" && fiatItem && <FiatDetailScreen item={fiatItem} onDone={() => go("activity")} />}
        {screen === "fiat-ledger-detail" && ledgerItem && <FiatLedgerDetailScreen item={ledgerItem} onDone={() => go("activity")} />}
        {(screen === "home" || screen === "activity" || screen === "profile") && (
          <TabBar current={screen} go={go} />
        )}
          </>
        )}
        <StatusBar style="light" />
      </SafeAreaView>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
});
