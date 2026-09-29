"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { Topbar, type WorkspaceTab } from "./topbar";

const API_BASE = process.env.NEXT_PUBLIC_PID_API_URL ?? "https://api.pid.peridotvault.com";
// "production" (real money) or "sandbox" (DOKU sandbox). This workspace is bound
// to one environment at build time; apps are registered separately per env.
// Explicit NEXT_PUBLIC_PID_ENV wins; otherwise the badge follows the API URL
// (loopback = sandbox) so it can never disagree with where traffic goes.
function apiHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}
const LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(apiHost(API_BASE));
const PID_ENV =
  process.env.NEXT_PUBLIC_PID_ENV ?? (LOOPBACK ? "sandbox" : "production");
// The workspace is first-party: it authenticates through the wallet app (popup)
// and shares the session cookie. In dev that wallet is the local Expo web app.
const POPUP_URL =
  process.env.NEXT_PUBLIC_PID_POPUP_URL ??
  (LOOPBACK
    ? "http://localhost:8081"
    : PID_ENV === "production"
      ? "https://app.pid.peridotvault.com"
      : "https://app.sandbox.pid.peridotvault.com");
const OTHER_WORKSPACE_URL = process.env.NEXT_PUBLIC_PID_OTHER_WORKSPACE_URL;
// The workspace's own session namespace: its cookies/session are separate from
// the wallet's, so signing out here never signs the user out of the wallet.
const SESSION_SCOPE = "web";

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
  const router = useRouter();
  const pathname = usePathname();

  const refreshSession = useCallback(async () => {
    try {
      let me = await client.identity.me();
      // Access tokens are short-lived; the scoped refresh cookie revives the
      // workspace session without a fresh popup login.
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
      router.push("/workspace");
    }
  }, [client, router]);

  const isAdmin = role === "admin";
  // Tabs are routes now (?tab= retired): active state follows the pathname.
  const tab =
    pathname?.startsWith("/workspace/contracts") === true
      ? "contracts"
      : pathname?.startsWith("/workspace/chains") === true
        ? "chains"
        : pathname?.startsWith("/workspace/partners") === true
          ? "partners"
          : "apps";
  const tabs = useMemo<WorkspaceTab[]>(
    () =>
      isAdmin
        ? [
            { key: "apps", label: "Apps" },
            { key: "chains", label: "Chains" },
            { key: "contracts", label: "Contracts" },
            { key: "partners", label: "Partners" },
          ]
        : [{ key: "apps", label: "Apps" }],
    [isAdmin],
  );

  const onTab = useCallback(
    (key: string) => {
      router.push(key === "apps" ? "/workspace" : `/workspace/${key}`);
    },
    [router],
  );

  const [contractChainId, setContractChainId] = useState<string | null>(null);
  const openContracts = useCallback(
    (chainId?: string) => {
      if (chainId) setContractChainId(chainId);
      router.push("/workspace/contracts");
    },
    [router],
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
      contractChainId,
      openContracts,
      env: PID_ENV,
      otherWorkspaceUrl: OTHER_WORKSPACE_URL,
      busy,
      error,
      signIn,
      signOut,
    }),
    [client, status, role, isAdmin, pid, tabs, tab, onTab, contractChainId, openContracts, busy, error, signIn, signOut],
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
