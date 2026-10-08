import "./polyfills";
import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { Peridot, BrowserPasskeySigner } from "@peridotvault/pid-sdk-js";
import { readPopupParams } from "@peridotvault/pid-sdk-js";
import { API_BASE_URL } from "./src/shared/config";
import { AppContext } from "./src/shared/AppContext";
import { readEmbedParams, createEmbedClient } from "./src/feat/embed/embed-client";
import { useEmbedBridge } from "./src/feat/embed/useEmbedBridge";
import { EmbedConnectScreen } from "./src/feat/embed/EmbedConnectScreen";
import { readLoginContext } from "./src/feat/auth/popup-login";
import { theme } from "./src/shared/theme";
import { AppColumn } from "./src/shared/components/AppColumn";
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
import { TabBar, type TabKey } from "./src/shared/components/TabBar";
import { TopBar } from "./src/feat/wallet/components/TopBar";
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
  // Third-party embed (`?embed=1&origin=…`): the wallet renders inside a dapp's
  // iframe. No inline signer — writes open the PeridotID popup; reads use the
  // read-only bearer the parent hands over.
  const [embedParams] = useState(readEmbedParams);
  const embed = useEmbedBridge(embedParams);

  // Built in-state (not module scope): any 401 outside /v1/auth/* kicks back
  // to login instead of stranding the app on a dead session. Idempotent —
  // the login screen makes no auto-auth calls outside SSO, so no loops.
  const [peridot] = useState(() =>
    embedParams
      ? createEmbedClient(API_BASE_URL)
      : Peridot({
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
  // Feed the delegated bearer into the client once the parent sends it.
  useEffect(() => {
    if (embed.bearer) peridot.setBearer(embed.bearer);
  }, [embed.bearer, peridot]);
  const session = useSessionBootstrap(peridot, {
    loginContext,
    setScreen,
    paused: !!embedParams && !embed.bearer,
  });
  const gate = useStartupGate();
  useSessionSync({
    bootstrap: session.bootstrap,
    disabled: !!popupRequest || !!loginContext || !!embedParams,
    isAuthed: session.authed,
  });

  const [activityTx, setActivityTx] = useState<WalletTransaction | null>(null);
  const [fiatItem, setFiatItem] = useState<FiatItem | null>(null);
  const [ledgerItem, setLedgerItem] = useState<FiatLedgerItem | null>(null);

  // Overlay stack: pushes render as opaque overlays over the sm content box
  // instead of replacing the tab root beneath (chrome stays visible). pop()
  // doubles as overlay dismiss for every screen's onDone — and remounts the
  // base (epoch) so data is exactly as fresh as the old replace-navigation.
  const [stack, setStack] = useState<Screen[]>([]);
  const [epoch, setEpoch] = useState(0);
  const push = useCallback((s: Screen) => setStack((prev) => [...prev, s]), []);
  const pop = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
    setEpoch((n) => n + 1);
  }, []);
  const goTab = useCallback((t: TabKey) => {
    setStack([]);
    setScreen(t);
  }, []);
  // Persistent shell chrome (top bar + tab bar/sidebar) mounts on tab roots
  // only — pushes render chromeless, as before.
  const isTabRoot = screen === "home" || screen === "activity" || screen === "profile";

  // The stack only lives under tab roots: leaving them (login, provisioning)
  // drops any stale overlay so it can never resurface on the next identity.
  useEffect(() => {
    if (!isTabRoot) setStack([]);
  }, [isTabRoot]);

  const openPasskey = useCallback(() => {
    push("passkey");
  }, [push]);

  const openActivityDetail = useCallback(
    (tx: WalletTransaction) => {
      setActivityTx(tx);
      push("activity-detail");
    },
    [push],
  );

  const openFiatDetail = useCallback(
    (item: FiatItem) => {
      setFiatItem(item);
      push("fiat-detail");
    },
    [push],
  );

  const openLedgerDetail = useCallback(
    (item: FiatLedgerItem) => {
      setLedgerItem(item);
      push("fiat-ledger-detail");
    },
    [push],
  );

  // Top-of-stack overlay screen. Every push keeps its existing onDone
  // contract — Back buttons dismiss the overlay with zero screen changes.
  const renderOverlay = () => {
    const top = stack[stack.length - 1];
    switch (top) {
      case "send":
        return <SendScreen onDone={pop} />;
      case "fiat-transfer":
        return <FiatTransferScreen onDone={pop} />;
      case "receive":
        return <ReceiveScreen onDone={pop} goPasskey={openPasskey} />;
      case "swap":
        return <SwapScreen onDone={pop} />;
      case "topup":
        return <TopupScreen onDone={pop} />;
      case "passkey":
        return <PasskeyScreen onDone={pop} />;
      case "activation":
        return <ActivationScreen onDone={pop} goPasskey={openPasskey} />;
      case "settings":
        return (
          <SettingsScreen
            goPasskeys={openPasskey}
            goSessions={() => push("sessions")}
            goConnected={() => push("connected")}
            onDone={pop}
          />
        );
      case "edit-profile":
        return <EditProfileScreen onDone={pop} />;
      case "sessions":
        return <SessionsScreen onDone={pop} />;
      case "connected":
        return <ConnectedAccountsScreen onDone={pop} />;
      case "app-connections":
        return <AppConnectionsScreen onDone={pop} />;
      case "activity-detail":
        return activityTx ? <ActivityDetailScreen tx={activityTx} onDone={pop} /> : undefined;
      case "fiat-detail":
        return fiatItem ? <FiatDetailScreen item={fiatItem} onDone={pop} /> : undefined;
      case "fiat-ledger-detail":
        return ledgerItem ? <FiatLedgerDetailScreen item={ledgerItem} onDone={pop} /> : undefined;
      default:
        return undefined;
    }
  };

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

  // Embedded and not yet authenticated: ask the parent to run the login popup.
  if (embedParams && !embed.bearer) {
    return <EmbedConnectScreen onConnect={embed.requestLogin} />;
  }

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
              <ApproveScreen
                popup={popupRequest}
                onNeedAuth={(reason) => {
                  session.setStepUp(reason === "step-up");
                  session.setAuthed(false);
                }}
              />
            ) : (
              // No session in this popup window: sign in here first, then the
              // approval resumes (popup params are persisted across the OAuth
              // round-trip by readPopupParams).
              <LoginScreen
                onLoggedIn={() => {
                  session.setStepUp(false);
                  session.setAuthed(true);
                }}
                stepUp={session.stepUp}
              />
            )
        ) : screen === "login" ? (
          // Standalone login (plain, SSO entry, auth-in-a-new-tab): full-bleed
          // public page. The in-column LoginScreen below then only serves the
          // authed SSO consent overlay over the app.
          <LoginScreen
            onLoggedIn={loginContext ? () => {} : session.handleLoggedIn}
            loginContext={loginContext}
            stepUp={session.stepUp}
          />
        ) : (
          <AppColumn
            top={
              isTabRoot ? (
                <TopBar onConnections={() => push("app-connections")} refreshKey={`${screen}-${epoch}`} />
              ) : undefined
            }
            side={isTabRoot ? <TabBar current={screen} go={goTab} /> : undefined}
            overlay={isTabRoot ? renderOverlay() : undefined}
          >
            <View key={epoch} style={styles.base}>
              {ssoRequest && (
                <LoginScreen
                  onLoggedIn={loginContext ? () => {} : session.handleLoggedIn}
                  loginContext={loginContext}
                  stepUp={session.stepUp}
                />
              )}
              {screen === "home" && (
                <HomeScreen
                  goSend={() => push("send")}
                  goReceive={() => push("receive")}
                  goSwap={() => push("swap")}
                  goBuy={() => push("topup")}
                  goTransfer={() => push("fiat-transfer")}
                  goPasskeys={openPasskey}
                />
              )}
              {screen === "activity" && (
                <ActivityScreen onSelect={openActivityDetail} onSelectFiat={openFiatDetail} onSelectLedger={openLedgerDetail} />
              )}
              {screen === "profile" && (
                <ProfileScreen
                  onLogout={logout}
                  goSettings={() => push("settings")}
                  goEditProfile={() => push("edit-profile")}
                  onSwitched={() => {
                    setStack([]);
                    session.reloadSession();
                  }}
                  onAddAccount={() => setScreen("login")}
                />
              )}
              {screen === "provisioning" && <ProvisioningScreen onContinue={() => goTab("home")} />}
            </View>
          </AppColumn>
        )}
        <StatusBar style="light" />
      </SafeAreaView>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  base: { flex: 1 },
});
