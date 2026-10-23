import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
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

  const refreshSession = useCallback(async () => {
    try {
      let me = await client.identity.me();
      // Access tokens are short-lived; the scoped refresh cookie revives the
      // dashboard session without a fresh popup login.
      if ("statusCode" in me && (await client.auth.refresh()) === true) {
        me = await client.identity.me();
      }
      if ("statusCode" in me) {
        setStatus("anonymous");
      } else {
        setStatus("owner");
        setRole(me.role ?? "user");
        setIdentityId(me.pid);
      }
    } catch {
      setStatus("anonymous");
    }
  }, [client]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // First-party sign-in: the wallet app (popup) handles Google + passkey + the
  // account switcher. No client_id/secret — the session cookie is shared.
  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await client.auth.loginPopup({ firstParty: true, sessionScope: SESSION_SCOPE });
      await refreshSession();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // User closed / cancelled the popup stays quiet; real failures surface.
      if (!/closed|cancel|denied|rejected/i.test(msg)) setError(msg || "Sign-in failed");
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
