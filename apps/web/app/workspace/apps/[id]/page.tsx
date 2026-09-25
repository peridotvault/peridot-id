"use client";

import { useParams } from "next/navigation";
import { AppDetail } from "../../_components/app-detail";
import { useWorkspace } from "../../_components/workspace-provider";
import { MUTED } from "../../_components/ui";

/** App Detail: escrow balance, callback endpoint, per-app fee schedule. */
export default function AppDetailPage() {
  const { client, status } = useWorkspace();
  const params = useParams<{ id: string | string[] }>();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id ?? "";

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
        <p className={`mt-8 text-sm ${MUTED}`}>Sign in to manage this app.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppDetail client={client} appId={id} />
    </main>
  );
}
