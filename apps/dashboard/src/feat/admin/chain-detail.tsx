import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useOutletContext } from "react-router";
import type { Chain, PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, MUTED } from "../../shared/ui/kit";
import { PageHeader } from "../../shared/ui/page-header";

export interface ChainDetailContext {
  client: PeridotClient;
  chain: Chain;
  /** Reload the chain row (contracts update after an upsert). */
  reload: () => Promise<void>;
}

export function useChainDetail() {
  return useOutletContext<ChainDetailContext>();
}

const TABS = [
  { key: "general", label: "General" },
  { key: "contracts", label: "Contracts" },
  { key: "tokens", label: "Tokens" },
];

/** One chain, focused: general settings, contracts, token deployments. */
export function ChainDetail({ client, chainId }: { client: PeridotClient; chainId: string }) {
  const [chain, setChain] = useState<Chain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const chains = await client.admin.chains().then((r) => unwrap({ ok: true, data: r }, "Loading chains"));
    setChain(chains.find((c) => c.id === chainId) ?? null);
  }, [client, chainId]);

  const reload = useCallback(async () => {
    try {
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chain");
    }
  }, [load]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  return (
    <>
      <PageHeader
        eyebrow="Chain"
        title={chain?.name ?? "Chain"}
        description={
          chain
            ? `${chain.namespace}:${chain.reference} · ${chain.nativeSymbol}${chain.isTestnet ? " · testnet" : ""}${chain.isActive ? "" : " · inactive"}`
            : undefined
        }
      />
      <div className="mt-6 flex flex-col gap-6">
        <p className="text-sm">
          <Link to="/admin/chains" className="text-muted-foreground transition-colors hover:text-foreground">
            ← Back to chains
          </Link>
        </p>

        {error && (
          <Card>
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          </Card>
        )}

        {loading && !chain && !error && (
          <Card>
            <p role="status" className={`text-sm ${MUTED}`}>Loading…</p>
          </Card>
        )}

        {!loading && !chain && !error && (
          <Card>
            <p className={`text-sm ${MUTED}`}>Chain not found.</p>
          </Card>
        )}

        {chain && (
          <>
            <nav aria-label="Chain sections" className="flex flex-wrap gap-2">
              {TABS.map((t) => (
                <NavLink
                  key={t.key}
                  to={t.key}
                  className={({ isActive }) =>
                    `rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
                      isActive
                        ? "border-foreground bg-foreground text-background"
                        : "border-line text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    }`
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
            <Outlet context={{ client, chain, reload } satisfies ChainDetailContext} />
          </>
        )}
      </div>
    </>
  );
}
