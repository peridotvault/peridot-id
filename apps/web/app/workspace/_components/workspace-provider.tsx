"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { Topbar, type WorkspaceTab } from "./topbar";

const API_BASE = process.env.NEXT_PUBLIC_PID_API_URL ?? "https://api.pid.peridotvault.com";

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
  busy: boolean;
  error: string | null;
  signInWithGoogle: () => void;
  signInWithPasskey: () => void;
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
    Peridot({ baseUrl: API_BASE, solanaRpcUrl: "https://api.devnet.solana.com" }),
  );
  const [status, setStatus] = useState<WorkspaceStatus>("checking");
  const [role, setRole] = useState<Role>("user");
  const [pid, setIdentityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const cleanReturnTo = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("pid_code");
    return url.toString();
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const me = await client.identity.me();
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

  const signInWithGoogle = useCallback(() => {
    setBusy(true);
    setError(null);
    client.auth.login({ returnTo: cleanReturnTo() }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Google sign-in failed");
      setBusy(false);
    });
  }, [client, cleanReturnTo]);

  const signInWithPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.auth.loginWithPasskey({ returnTo: cleanReturnTo() });
      if (!res.ok) {
        setError("Sign-in was cancelled — try again.");
        return;
      }
      // Passkey returns no identity — reload role/id from the fresh session.
      await refreshSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [client, cleanReturnTo, refreshSession]);

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
        : "apps";
  const tabs = useMemo<WorkspaceTab[]>(
    () =>
      isAdmin
        ? [
            { key: "apps", label: "Apps" },
            { key: "chains", label: "Chains" },
            { key: "contracts", label: "Contracts" },
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
      busy,
      error,
      signInWithGoogle,
      signInWithPasskey,
      signOut,
    }),
    [client, status, role, isAdmin, pid, tabs, tab, onTab, contractChainId, openContracts, busy, error, signInWithGoogle, signInWithPasskey, signOut],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Layout-owned topbar fed from context (hidden until an owner session exists). */
export function WorkspaceTopbar() {
  const { status, tabs, tab, onTab, pid, isAdmin, signOut } = useWorkspace();
  if (status !== "owner") return null;
  return (
    <Topbar
      tabs={tabs}
      active={tab}
      onTab={onTab}
      sessionLabel={pid}
      isAdmin={isAdmin}
      onSignOut={() => void signOut()}
    />
  );
}
