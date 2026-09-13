"use client";

import Link from "next/link";
import { AppsManager } from "../_components/apps-manager";
import { useWorkspace } from "../_components/workspace-provider";
import { MUTED } from "../_components/ui";

/** Owner app list (open to all signed-in identities). */
export default function WorkspaceAppsPage() {
  const { client, status } = useWorkspace();

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
        <p className={`mt-8 text-sm ${MUTED}`}>
          <Link href="/workspace" className="underline">Sign in</Link> to manage your apps.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppsManager client={client} />
    </main>
  );
}
