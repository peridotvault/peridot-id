"use client";

import { AppsManager } from "./_components/apps-manager";
import { useWorkspace } from "./_components/workspace-provider";
import { Card, ERROR, MUTED } from "./_components/ui";
import { PageHeader } from "./_components/page-header";
import { CutButton } from "@/components/landing/cut-button";

/** Session gate: logged-out visitors get the login section, owners get Apps. */
export default function WorkspacePage() {
  const {
    client,
    status,
    busy,
    error,
    signInWithGoogle,
    signInWithPasskey,
  } = useWorkspace();

  if (status === "checking") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="PeridotID for developers" title="Workspace" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to manage your apps</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Register <code>client_id</code>s, edit redirect URIs, and generate backend secrets.
          </p>
          {error && <p className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <CutButton
              type="button"
              onClick={signInWithGoogle}
              disabled={busy}
              className={busy ? "pointer-events-none opacity-60" : ""}
            >
              Continue with Google
            </CutButton>
            <CutButton
              type="button"
              variant="outline"
              onClick={signInWithPasskey}
              disabled={busy}
              className={busy ? "pointer-events-none opacity-60" : ""}
            >
              {busy ? "Waiting…" : "Continue with Passkey"}
            </CutButton>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppsManager client={client} />
    </main>
  );
}
