import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Peridot } from "@peridotvault/pid-sdk-js";
import { Topbar } from "./topbar";
import { ProfileMenu } from "./profile-menu";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { PopupClosedError } from "@peridotvault/pid-sdk-js";
import { resolveBrowserUrl } from "../lib/api-base";
import {
  CONFIGURED_API_BASE,
  CONFIGURED_TESTNET_API_BASE,
  MODE,
  PID_ENV,
  POPUP_URL as CONFIGURED_POPUP_URL,
  SESSION_SCOPE,
  setMode,
  type DashboardMode,
} from "../lib/config";

// LAN-safe resolution (loopback→page-host swap) applied at runtime, same as
// apps/docs. The badge in lib/config follows the configured URL, not this one.
const API_BASE = resolveBrowserUrl(CONFIGURED_API_BASE);
const TESTNET_API_BASE = resolveBrowserUrl(CONFIGURED_TESTNET_API_BASE);
const POPUP_URL = resolveBrowserUrl(CONFIGURED_POPUP_URL);

/** API base per network — one dashboard origin serves both. */
export const API_BASE_BY_MODE: Record<DashboardMode, string> = {
  mainnet: API_BASE,
  testnet: TESTNET_API_BASE,
};

export type WorkspaceStatus = "checking" | "anonymous" | "owner";

interface WorkspaceContextValue {
  client: PeridotClient;
  /** Per-network clients: the apps list merges both environments. */
  clientFor: (mode: DashboardMode) => PeridotClient;
  mode: DashboardMode;
  setMode: (mode: DashboardMode) => void;
  status: WorkspaceStatus;
  role: Role;
  isAdmin: boolean;
  pid: string;
  env: string;
  busy: boolean;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used under <WorkspaceProvider>");
  return ctx;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // One client per network. Both ride the same shared session cookie (mainnet
  // mints it; the testnet API verifies it by introspection), and each carries
  // its own `env` so the wallet login tab opens the matching network.
  const [clients] = useState<Record<DashboardMode, PeridotClient>>(() => ({
    mainnet: Peridot({
      baseUrl: API_BASE,
      popupBaseUrl: POPUP_URL,
      sessionScope: SESSION_SCOPE,
      env: "production",
    }),
    testnet: Peridot({
      baseUrl: TESTNET_API_BASE,
      popupBaseUrl: POPUP_URL,
      sessionScope: SESSION_SCOPE,
      env: "sandbox",
    }),
  }));
  const mode = MODE;
  const client = clients[mode];
  const clientFor = useCallback((m: DashboardMode) => clients[m], [clients]);
  const [status, setStatus] = useState<WorkspaceStatus>("checking");
  const [role, setRole] = useState<Role>("user");
  const [pid, setIdentityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Resolves true when an owner session is established. Every anonymous
  // outcome resolves false so callers can surface it — the session check must
  // never fail silently (ANT-694: sandbox login showed no error because the
  // popup completed but the cookie never stuck).
  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      let me = await client.identity.me();
      // Access tokens are short-lived; the scoped refresh cookie revives the
      // dashboard session without a fresh popup login.
      if ("statusCode" in me && (await client.auth.refresh()) === true) {
        me = await client.identity.me();
      }
      if ("statusCode" in me) {
        setStatus("anonymous");
        return false;
      }
      setStatus("owner");
      setRole(me.role ?? "user");
      setIdentityId(me.pid);
      return true;
    } catch (e) {
      // A blocked fetch (e.g. CSP connect-src) is indistinguishable from a
      // missing session downstream — log the cause for DevTools diagnosis.
      // eslint-disable-next-line no-console
      console.warn("[workspace] session check failed:", e);
      setStatus("anonymous");
      return false;
    }
  }, [client]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // First-party sign-in: the wallet app handles Google + passkey + the account
  // switcher and the browser wallet extension. Opened as a full tab, never a
  // `window.open` popup: Chromium parents the extension's own notification
  // window to the requesting window, and a popup parent crashed Brave's
  // browser process on MetaMask's sign request (browser-level SIGTRAP, no JS
  // frame). A tab is the same shape as every other dapp that works.
  // No client_id/secret — the session cookie is shared.
  // ANT-694: every failure surfaces in `error`. Only a user-closed window
  // stays quiet; a completed window with no session (wrong-API build, blocked
  // third-party cookies, scope mismatch) reports instead of going silent.
  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await client.auth.loginTab({ firstParty: true, sessionScope: SESSION_SCOPE });
      const established = await refreshSession();
      if (!established) {
        setError(
          "Sign-in finished but no session was established. " +
            "This dashboard may be talking to a different API than the wallet popup " +
            "(sandbox vs production), or the browser blocked the session cookie. " +
            "Allow cookies for this site and try again.",
        );
      }
    } catch (e) {
      if (e instanceof PopupClosedError) {
        // User closed the popup before completing — stays quiet.
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || "Sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  }, [client, refreshSession]);

  const signOut = useCallback(async () => {
    try {
      await client.auth.logout();
    } catch {
      // Session already invalid server-side — still drop local state.
    } finally {
      setStatus("anonymous");
      setRole("user");
      setIdentityId("");
      setError(null);
      void navigate("/");
    }
  }, [client, navigate]);

  const isAdmin = role === "admin";

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      client,
      clientFor,
      mode,
      setMode,
      status,
      role,
      isAdmin,
      pid,
      env: PID_ENV,
      busy,
      error,
      signIn,
      signOut,
    }),
    [client, clientFor, mode, status, role, isAdmin, pid, busy, error, signIn, signOut],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Topbar in front of every route; the session gate stays in the layouts. */
export function WorkspaceTopbar() {
  return <Topbar account={<ProfileMenu />} />;
}
