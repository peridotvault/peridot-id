"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { PeridotClient, Role } from "@peridotvault/pid-sdk-js";
import { AppsManager } from "./_components/apps-manager";
import { ChainsManager } from "./_components/chains-manager";
import { Topbar } from "./_components/topbar";

const API_BASE = process.env.NEXT_PUBLIC_PID_API_URL ?? "https://api.pid.peridotvault.com";

/** Session gate: logged-out visitors get the login section, owners get the dashboard. */
export default function WorkspacePage() {
  return (
    <Suspense fallback={<p className="mx-auto w-full max-w-3xl px-5 py-16 text-sm text-neutral-500">Loading…</p>}>
      <Workspace />
    </Suspense>
  );
}

function Workspace() {
  const [client] = useState<PeridotClient>(() =>
    Peridot({ baseUrl: API_BASE, solanaRpcUrl: "https://api.devnet.solana.com" }),
  );
  const [status, setStatus] = useState<"checking" | "anonymous" | "owner">("checking");
  const [role, setRole] = useState<Role>("user");
  const [identityId, setIdentityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const cleanReturnTo = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("pid_code");
    return url.toString();
  }, []);

  useEffect(() => {
    let cancelled = false;
    client.identity
      .me()
      .then((me) => {
        if (cancelled) return;
        if ("statusCode" in me) {
          setStatus("anonymous");
        } else {
          setStatus("owner");
          setRole(me.role ?? "user");
          setIdentityId(me.id);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

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
      setStatus("owner");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [client, cleanReturnTo]);

  const isAdmin = role === "admin";
  // Unknown/hand-typed tabs (incl. chains for non-admins) fall back to apps —
  // the admin surface is undiscoverable, not just unclickable.
  const requested = searchParams.get("tab");
  const tab = requested === "chains" && isAdmin ? "chains" : "apps";
  const tabs = isAdmin
    ? [
        { key: "apps", label: "Apps" },
        { key: "chains", label: "Chains" },
      ]
    : [{ key: "apps", label: "Apps" }];

  const onTab = useCallback(
    (key: string) => {
      router.replace(`${pathname}?tab=${key}`, { scroll: false });
    },
    [router, pathname],
  );

  if (status === "checking") {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-16">
        <p className="mt-8 text-sm text-neutral-500">Checking session…</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-16">
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">PeridotID for developers</p>
        <h1 className="mt-2 text-3xl font-bold">Workspace</h1>
        <section className="mt-8 rounded-2xl border border-neutral-200 p-6">
          <h2 className="text-lg font-semibold">Sign in to manage your apps</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Register <code>client_id</code>s, edit redirect URIs, and generate backend secrets.
          </p>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={signInWithGoogle}
              disabled={busy}
              className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              Continue with Google
            </button>
            <button
              type="button"
              onClick={signInWithPasskey}
              disabled={busy}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              {busy ? "Waiting…" : "Continue with Passkey"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <>
      <Topbar tabs={tabs} active={tab} onTab={onTab} sessionLabel={identityId} isAdmin={isAdmin} />
      <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-8">
        {tab === "chains" ? <ChainsManager client={client} /> : <AppsManager client={client} />}
      </main>
    </>
  );
}
