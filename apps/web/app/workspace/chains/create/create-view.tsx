"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AddChainForm } from "../../_components/add-chain-form";
import { PageHeader } from "../../_components/page-header";
import { useWorkspace } from "../../_components/workspace-provider";
import { MUTED } from "../../_components/ui";

export function CreateChainView() {
  const { client, status, isAdmin } = useWorkspace();
  const router = useRouter();

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
      <PageHeader
        eyebrow="Chain registry"
        title="Add chain"
        description="Register a new EVM chain in the wallet registry."
      />
      <div className="mt-4">
        <AddChainForm client={client} onDone={() => router.push("/workspace/chains")} onError={() => {}} />
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link href="/workspace/chains" className="underline">Back to chains</Link>
      </p>
    </main>
  );
}
