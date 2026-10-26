import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { PopupClosedError } from "@peridotvault/pid-sdk-js";
import { Topbar, type WorkspaceTab } from "./topbar";
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
  contractChainId: string | null;
  openContracts: (chainId?: string) => void;
  clearContractChainId: () => void;
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

  // First-party sign-in: the wallet app (popup) handles Google + passkey + the
  // account switcher. No client_id/secret — the session cookie is shared.
  // ANT-694: every failure surfaces in `error`. Only a user-closed popup
  // stays quiet; a completed popup with no session (wrong-API build, blocked
  // third-party cookies, scope mismatch) reports instead of going silent.
  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await client.auth.loginPopup({ firstParty: true, sessionScope: SESSION_SCOPE });
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
  // Tabs are routes now (?tab= retired): active state follows the pathname.
  const tab =
    pathname?.startsWith("/leveling") === true
      ? "leveling"
      : pathname?.startsWith("/settings") === true
      ? "settings"
      : pathname?.startsWith("/contracts") === true
      ? "contracts"
      : pathname?.startsWith("/chains") === true
        ? "chains"
        : pathname?.startsWith("/tokens") === true
          ? "tokens"
          : pathname?.startsWith("/partners") === true
          ? "partners"
          : pathname?.startsWith("/fees") === true
            ? "fees"
            : "apps";
  const tabs = useMemo<WorkspaceTab[]>(
    () =>
      isAdmin
        ? [
            { key: "apps", label: "Apps" },
            { key: "chains", label: "Chains" },
            { key: "tokens", label: "Tokens" },
            { key: "contracts", label: "Contracts" },
            { key: "partners", label: "Partners" },
            { key: "fees", label: "Fees" },
            { key: "leveling", label: "Leveling" },
            { key: "settings", label: "System" },
          ]
        : [{ key: "apps", label: "Apps" }],
    [isAdmin],
  );

  const onTab = useCallback(
    (key: string) => {
      void navigate(key === "apps" ? "/" : `/${key}`);
    },
    [navigate],
  );

  const [contractChainId, setContractChainId] = useState<string | null>(null);
  const openContracts = useCallback(
    (chainId?: string) => {
      if (chainId) setContractChainId(chainId);
      void navigate("/contracts");
    },
    [navigate],
  );
  // ANT-341 FR7: the handoff is single-use — ContractsManager clears it after
  // consume so a later visit never re-selects a stale chain.
  const clearContractChainId = useCallback(() => setContractChainId(null), []);

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
      contractChainId,
      openContracts,
      clearContractChainId,
      env: PID_ENV,
      otherWorkspaceUrl: OTHER_WORKSPACE_URL,
      busy,
      error,
      signIn,
      signOut,
    }),
    [client, status, role, isAdmin, pid, tabs, tab, onTab, contractChainId, openContracts, clearContractChainId, busy, error, signIn, signOut],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Layout-owned topbar fed from context (hidden until an owner session exists). */
export function WorkspaceTopbar() {
  const { status, tabs, tab, onTab, pid, isAdmin, signOut, env, otherWorkspaceUrl } = useWorkspace();
  if (status !== "owner") return null;
  return (
    <Topbar
      tabs={tabs}
      active={tab}
      onTab={onTab}
      sessionLabel={pid}
      isAdmin={isAdmin}
      env={env}
      otherWorkspaceUrl={otherWorkspaceUrl}
      onSignOut={() => void signOut()}
    />
  );
}
