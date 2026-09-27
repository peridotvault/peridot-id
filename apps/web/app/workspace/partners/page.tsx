"use client";

import Link from "next/link";
import { PartnersManager } from "../_components/partners-manager";
import { useWorkspace } from "../_components/workspace-provider";
import { MUTED } from "../_components/ui";

/** Admin partner directory (verify/unverify apps). */
export default function WorkspacePartnersPage() {
  const { client, status, isAdmin } = useWorkspace();

  if (status === "checking") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`text-sm ${MUTED}`}>
          Admin only. <Link href="/workspace" className="underline">Back to workspace</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <PartnersManager client={client} />
    </main>
  );
}
