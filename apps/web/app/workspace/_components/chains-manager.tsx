"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, ERROR, MUTED, MiniButton } from "./ui";
import { PageHeader } from "./page-header";
import { useWorkspace } from "./workspace-provider";

/** Admin chain registry: browse chains, toggle availability, jump to contracts. */
export function ChainsManager({ client }: { client: PeridotClient }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setChains(await client.admin.chains().then((r) => unwrap({ ok: true, data: r }, "Loading chains")));
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chains"))
      .finally(() => setLoading(false));
  }, [load]);

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="Chain registry"
        title="Chains"
        description="Control which chains the wallet renders and activation uses."
      />
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {loading ? (
        <p className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/workspace/chains/create"
            className="focus-ring flex min-h-32 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span aria-hidden="true" className="text-2xl leading-none">+</span>
            Add chain
          </Link>
          {chains.map((c) => (
            <ChainCard
              key={c.id}
              client={client}
              chain={c}
              onChanged={load}
              onError={setError}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChainCard({
  client,
  chain,
  onChanged,
  onError,
}: {
  client: PeridotClient;
  chain: Chain;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { openContracts } = useWorkspace();

  const setActive = async (isActive: boolean) => {
    setBusy(true);
    onError(null);
    try {
      await client.admin.updateChain(chain.id, { isActive }).then((r) => unwrap({ ok: true, data: r }, "Updating chain"));
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const contractCount = (chain.contracts ?? []).length;

  return (
    <Card className={chain.isActive ? "" : "opacity-60"}>
      <div className="flex items-center gap-3">
        {chain.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={chain.logoUrl} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-bold">
            {chain.nativeSymbol.slice(0, 3)}
          </span>
        )}
        <span className="font-semibold tracking-tight">{chain.name}</span>
      </div>
      <p className={`mt-2 text-xs ${MUTED}`}>
        {chain.namespace}:{chain.reference} · {chain.nativeSymbol}
        {chain.isTestnet && " · testnet"}
      </p>
      <p className={`mt-1 text-xs ${MUTED}`}>
        {contractCount === 0 ? "No contracts yet" : `${contractCount} contract${contractCount === 1 ? "" : "s"}`}
        {!chain.isActive && <span className={`font-semibold ${ERROR}`}> · disabled</span>}
      </p>
      <div className="mt-3 flex gap-2">
        <MiniButton size="sm" disabled={busy} onClick={() => setActive(!chain.isActive)}>
          {chain.isActive ? "Disable" : "Enable"}
        </MiniButton>
        <MiniButton size="sm" onClick={() => router.push(`/workspace/chains/edit?id=${chain.id}`)}>
          Edit
        </MiniButton>
        <MiniButton size="sm" onClick={() => openContracts(chain.id)}>
          Contracts →
        </MiniButton>
      </div>
    </Card>
  );
}
