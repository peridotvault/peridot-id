"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, MUTED, MiniButton } from "../../shared/ui/kit";
import { PageHeader } from "../../shared/ui/page-header";

/** Admin chain registry: one card per chain, opening its detail page. */
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

  // Inline retry next to the error: without this the only recovery is a full
  // page reload. Same load path as the initial fetch.
  const retry = useCallback(() => {
    setLoading(true);
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chains"))
      .finally(() => setLoading(false));
  }, [load]);

  return (
    <section>
      <PageHeader
        eyebrow="Chain registry"
        title="Chains"
        description="Control which chains the wallet renders and activation uses. Open a chain for its settings, contracts and tokens."
      />
      {error && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={retry}>
            Retry
          </MiniButton>
        </div>
      )}
      {loading ? (
        <p role="status" className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : chains.length === 0 ? (
        // ANT-341 FR7: explicit empty state (never a bare grid with just "+ Add chain").
        <div className="mt-4">
          <p className={`text-sm ${MUTED}`}>No chains registered yet — add your first chain below.</p>
          <Link
            to="/admin/chains/create"
            className="focus-ring mt-3 flex min-h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground sm:w-1/2 lg:w-1/3"
          >
            <span aria-hidden="true" className="text-2xl leading-none">+</span>
            Add chain
          </Link>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            to="/admin/chains/create"
            className="focus-ring flex min-h-32 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <span aria-hidden="true" className="text-2xl leading-none">+</span>
            Add chain
          </Link>
          {chains.map((c) => (
            <ChainCard key={c.id} chain={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ChainCard({ chain }: { chain: Chain }) {
  const contractCount = (chain.contracts ?? []).length;

  return (
    <Link to={`/admin/chains/${chain.id}`} className="focus-ring block">
      <Card className={`transition-colors hover:bg-muted/40 ${chain.isActive ? "" : "opacity-60"}`}>
        <div className="flex items-center gap-3">
          {chain.logoUrl ? (
            // Plain img: no Next.js Image optimizer in the Vite app.
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
      </Card>
    </Link>
  );
}
