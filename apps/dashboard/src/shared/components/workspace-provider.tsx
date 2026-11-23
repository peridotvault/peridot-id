import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Peridot } from "@peridotvault/pid-sdk-js";
import { Topbar, type WorkspaceTab } from "./topbar";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { PopupClosedError } from "@peridotvault/pid-sdk-js";
import { resolveBrowserUrl } from "../lib/api-base";
import {
  CONFIGURED_API_BASE,
  OTHER_WORKSPACE_URL,
  PID_ENV,
  POPUP_URL as CONFIGURED_POPUP_URL,
  SESSION_SCOPE,
} from "../lib/config";

// LAN-safe resolution (loopback→page-host swap) applied at runtime, same as
// apps/docs. The badge in lib/config follows the configured URL, not this one.
const API_BASE = resolveBrowserUrl(CONFIGURED_API_BASE);
const POPUP_URL = resolveBrowserUrl(CONFIGURED_POPUP_URL);

export type WorkspaceStatus = "checking" | "anonymous" | "owner";

interface WorkspaceContextValue {
  client: PeridotClient;
  status: WorkspaceStatus;
  role: Role;
  isAdmin: boolean;
  pid: string;
  tabs: WorkspaceTab[];
  tab: string;
  onTab: (key: string) => void;
  env: string;
  otherWorkspaceUrl?: string;
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
  const [client] = useState<PeridotClient>(() =>
    Peridot({ baseUrl: API_BASE, popupBaseUrl: POPUP_URL, sessionScope: SESSION_SCOPE }),
  );
  const [status, setStatus] = useState<WorkspaceStatus>("checking");
  const [role, setRole] = useState<Role>("user");
  const [pid, setIdentityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

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
  // Two areas, not two nav sets: the developer workspace owns apps only.
  // Chains, fees, partners, leveling and system settings live in /admin.
  const tab = pathname?.startsWith("/admin") === true ? "admin" : "apps";
  const tabs = useMemo<WorkspaceTab[]>(
    () => (isAdmin ? [{ key: "apps", label: "Apps" }, { key: "admin", label: "Admin" }] : [{ key: "apps", label: "Apps" }]),
    [isAdmin],
  );
  const onTab = useCallback(
    (key: string) => {
      void navigate(key === "admin" ? "/admin" : "/");
    },
    [navigate],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      client,
      status,
      role,
      isAdmin,
      pid,
      tabs,
      tab,
      onTab,
      env: PID_ENV,
      otherWorkspaceUrl: OTHER_WORKSPACE_URL,
      busy,
      error,
      signIn,
      signOut,
    }),
    [client, status, role, isAdmin, pid, tabs, tab, onTab, busy, error, signIn, signOut],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Topbar in front of every route; the session gate stays in the layouts. */
export function WorkspaceTopbar() {
  const { tabs, tab, onTab, pid, isAdmin, env, otherWorkspaceUrl, signOut } = useWorkspace();
  return (
    <Topbar
      tabs={tabs}
      active={tab}
      onTab={onTab}
      sessionLabel={pid || "signed out"}
      isAdmin={isAdmin}
      env={env}
      otherWorkspaceUrl={otherWorkspaceUrl}
      onSignOut={() => void signOut()}
    />
  );
}
