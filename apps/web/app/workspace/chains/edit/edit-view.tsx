"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Chain } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../_components/api";
import { EditChainForm } from "../../_components/edit-chain-form";
import { PageHeader } from "../../_components/page-header";
import { useWorkspace } from "../../_components/workspace-provider";
import { Card, ERROR, MUTED } from "../../_components/ui";

export function EditChainView() {
  const { client, status, isAdmin } = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const [chain, setChain] = useState<Chain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const chains = await client.admin.chains().then((r) => unwrap({ ok: true, data: r }, "Loading chains"));
    setChain(chains.find((c) => c.id === id) ?? null);
  }, [client, id]);

  useEffect(() => {
    if (status !== "checking" && isAdmin && id) {
      load()
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chain"))
        .finally(() => setLoading(false));
    } else if (status !== "checking") {
      setLoading(false);
    }
  }, [load, status, isAdmin, id]);

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
        title="Edit chain"
        description="Update metadata, RPCs, and availability for this chain."
      />
      <div className="mt-4">
        {loading ? (
          <p className={`text-sm ${MUTED}`}>Loading…</p>
        ) : error ? (
          <p className={`text-sm ${ERROR}`}>{error}</p>
        ) : !id || !chain ? (
          <p className={`text-sm ${MUTED}`}>
            Chain not found. <Link href="/workspace/chains" className="underline">Back to chains</Link>
          </p>
        ) : (
          <Card>
            <EditChainForm client={client} chain={chain} onDone={() => router.push("/workspace/chains")} />
          </Card>
        )}
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link href="/workspace/chains" className="underline">Back to chains</Link>
      </p>
    </main>
  );
}
