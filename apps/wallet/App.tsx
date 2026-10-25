import { useCallback, useEffect, useState } from "react";
import { StyleSheet, flatten } from "./src/shared/styles/stylesheet";
import { Peridot, BrowserPasskeySigner } from "@peridotvault/pid-sdk-js";
import { readPopupParams } from "@peridotvault/pid-sdk-js";
import { API_BASE_URL } from "./src/shared/app/config";
import { clearApiCache } from "./src/shared/data/api-cache";
import { AppContext } from "./src/shared/app/AppContext";
import { readEmbedParams, createEmbedClient } from "./src/feat/embed/utils/embed-client";
import { useEmbedBridge } from "./src/feat/embed/hooks/useEmbedBridge";
import { EmbedConnect } from "./src/pages/embed/EmbedConnect";
import { readLoginContext } from "./src/feat/auth/utils/popup-login";
import { theme } from "./src/shared/styles/theme";
import { AppColumn } from "./src/shared/components/shell/AppColumn";
import { useStartupGate } from "./src/shared/hooks/useStartupGate";
import { useSessionBootstrap, type Screen } from "./src/shared/hooks/useSessionBootstrap";
import { useSessionSync } from "./src/shared/hooks/useSessionSync";
import { Login } from "./src/pages/auth/Login";
import { LoadingScreen } from "./src/shared/components/shell/LoadingScreen";
import { readSsoParams } from "./src/feat/auth/utils/sso";
import { Home } from "./src/pages/wallet/Home";
import { Approve } from "./src/pages/auth/Approve";
import { Send } from "./src/pages/wallet/Send";
import { Receive } from "./src/pages/wallet/Receive";
import { Swap } from "./src/pages/wallet/Swap";
import { Topup } from "./src/pages/fiat/Topup";
import { Provisioning } from "./src/pages/auth/Provisioning";
import { Passkey } from "./src/pages/identity/Passkey";
import { Settings } from "./src/pages/identity/Settings";
import { Profile } from "./src/pages/identity/Profile";
import { EditProfile } from "./src/pages/identity/EditProfile";
import { Sessions } from "./src/pages/identity/Sessions";
import { ConnectedAccounts } from "./src/pages/identity/ConnectedAccounts";
import { AppConnections } from "./src/pages/identity/AppConnections";
import { Activity } from "./src/pages/activity/Activity";
import { ActivityDetail } from "./src/pages/activity/ActivityDetail";
import { FiatDetail } from "./src/pages/fiat/FiatDetail";
import { FiatAccount } from "./src/pages/fiat/FiatAccount";
import { UIButton } from "./src/shared/components/ui/UIButton";
import { FiatTransfer } from "./src/pages/fiat/FiatTransfer";
import { FiatLedgerDetail } from "./src/pages/fiat/FiatLedgerDetail";
import { TabBar, type TabKey } from "./src/shared/components/shell/TabBar";
import { TopBar } from "./src/shared/components/shell/TopBar";
import { Activation } from "./src/pages/wallet/Activation";
import type { WalletTransaction } from "@peridotvault/pid-types";
import type { FiatItem, FiatLedgerItem } from "./src/shared/data/fiat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  // Third-party SSO request (?redirect_uri=…): Login handles it even when logged
  // in (consent flow) — otherwise a logged-in user landing here would sit on Home
  // with the request silently ignored.
  const [ssoRequest] = useState(readSsoParams);
  // Auth-in-a-new-tab (`?popup=login&origin=…&client_id=…`): the tab stays on
  // the login screen to authenticate (and create a PID if missing), then mints a
  // pid_code for the opener. Survives the OAuth round-trip via sessionStorage.
  const [loginContext] = useState(readLoginContext);
  // Popup sign request (`?popup=<action>&origin=…` opened by a dapp): the
  // approval screen takes over the whole app — never the normal wallet flow.
  // (`?popup=login` stays on the normal flow; Login delivers via popup.)
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
  const isTabRoot = screen === "home" || screen === "activity" || screen === "settings";

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
        return <Send onDone={pop} />;
      case "fiat-transfer":
        return <FiatTransfer onDone={pop} />;
      case "receive":
        return <Receive onDone={pop} goPasskey={openPasskey} />;
      case "swap":
        return <Swap onDone={pop} />;
      case "topup":
        return <Topup onDone={pop} />;
      case "passkey":
        return <Passkey onDone={pop} />;
      case "activation":
        return <Activation onDone={pop} goPasskey={openPasskey} />;
      case "profile":
        return (
          <Profile
            onDone={pop}
            onLogout={logout}
            goEditProfile={() => push("edit-profile")}
            onSwitched={() => {
              setStack([]);
              clearApiCache();
              session.reloadSession();
            }}
            onAddAccount={() => setScreen("login")}
          />
        );
      case "edit-profile":
        return <EditProfile onDone={pop} />;
      case "sessions":
        return <Sessions onDone={pop} />;
      case "connected":
        return <ConnectedAccounts onDone={pop} />;
      case "app-connections":
        return <AppConnections onDone={pop} />;
      case "activity-detail":
        // ANT-341 FR4: null payload never strands a bare overlay — fallback
        // with a working Close that pops the stack.
        return activityTx ? (
          <ActivityDetail tx={activityTx} onDone={pop} />
        ) : (
          <NullOverlayFallback label="Activity detail" onClose={pop} />
        );
      case "fiat-account":
        return <FiatAccount onDone={pop} goSend={() => push("fiat-transfer")} goTopup={() => push("topup")} />;
      case "fiat-detail":
        return fiatItem ? (
          <FiatDetail item={fiatItem} onDone={pop} />
        ) : (
          <NullOverlayFallback label="Fiat detail" onClose={pop} />
        );
      case "fiat-ledger-detail":
        return ledgerItem ? (
          <FiatLedgerDetail item={ledgerItem} onDone={pop} />
        ) : (
          <NullOverlayFallback label="Ledger detail" onClose={pop} />
        );
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
      clearApiCache();
      session.setAuthed(false);
      setScreen("login");
    }
  }, [peridot, session]);

  // Embedded and not yet authenticated: ask the parent to run the login popup.
  if (embedParams && !embed.bearer) {
    return <EmbedConnect onConnect={embed.requestLogin} />;
  }

  // Paint first, complete later: the branded loader shows instantly (system
  // fallbacks) while fonts download and the session check runs in parallel.
  // fontError skips the font wait; gateForced opens after 8s no matter what.
  if ((session.bootstrapping || (!gate.fontsLoaded && !gate.fontError)) && !gate.gateForced) {
    return <LoadingScreen fontsReady={gate.fontsLoaded} />;
  }

  return (
    <AppContext.Provider value={{ peridot }}>
      <a
        href="#wallet-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-foreground focus:px-3 focus:py-2 focus:text-sm focus:text-background"
      >
        Skip to content
      </a>
      <div style={flatten([styles.safe, { backgroundColor: theme.colors.background }])} className="flex flex-col">
          {popupRequest ? (
            session.authed ? (
              <Approve
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
              <Login
                onLoggedIn={() => {
                  session.setStepUp(false);
                  session.setAuthed(true);
                }}
                stepUp={session.stepUp}
              />
            )
        ) : screen === "login" ? (
          // Standalone login (plain, SSO entry, auth-in-a-new-tab): full-bleed
          // public page. The in-column Login below then only serves the
          // authed SSO consent overlay over the app.
          <Login
            onLoggedIn={loginContext ? () => {} : session.handleLoggedIn}
            loginContext={loginContext}
            stepUp={session.stepUp}
          />
        ) : (
          <AppColumn
            top={
              isTabRoot ? (
                <TopBar onProfile={() => push("profile")} refreshKey={`${screen}-${epoch}`} />
              ) : undefined
            }
            side={isTabRoot ? <TabBar current={screen} go={goTab} /> : undefined}
            overlay={isTabRoot ? renderOverlay() : undefined}
          >
            <div key={epoch} style={styles.base} id="wallet-main" className="flex flex-col">
              {ssoRequest && (
                <Login
                  onLoggedIn={loginContext ? () => {} : session.handleLoggedIn}
                  loginContext={loginContext}
                  stepUp={session.stepUp}
                />
              )}
              {screen === "home" && (
                <Home
                  goSend={() => push("send")}
                  goReceive={() => push("receive")}
                  goSwap={() => push("swap")}
                  goBuy={() => push("topup")}
                  goTransfer={() => push("fiat-transfer")}
                  goRupiah={() => push("fiat-account")}
                  goPasskeys={openPasskey}
                />
              )}
              {screen === "activity" && (
                <Activity onSelect={openActivityDetail} onSelectFiat={openFiatDetail} onSelectLedger={openLedgerDetail} />
              )}
              {screen === "settings" && (
                <Settings
                  goPasskeys={openPasskey}
                  goSessions={() => push("sessions")}
                  goConnected={() => push("connected")}
                  goAppConnections={() => push("app-connections")}
                  onDone={() => goTab("home")}
                  onLogout={logout}
                  tabRoot
                />
              )}
              {screen === "provisioning" && <Provisioning onContinue={() => goTab("home")} />}
            </div>
          </AppColumn>
        )}
      </div>
    </AppContext.Provider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  base: { flex: 1 },
});

/** ANT-341 FR4: stranded-screen guard — a detail overlay pushed with a null
 * payload renders an explicit fallback with a working Close (pops the stack)
 * instead of a bare undefined overlay. */
function NullOverlayFallback({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div style={styles.base} className="flex flex-col">
      <span style={{ fontSize: 18, fontWeight: "700" }}>{label} unavailable</span>
      <span style={{ fontSize: 14, opacity: 0.7 }}>This item is no longer available.</span>
      <UIButton title="Close" onPress={onClose} variant="primary" />
    </div>
  );
}
