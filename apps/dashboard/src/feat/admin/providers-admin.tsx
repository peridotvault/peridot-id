import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, MUTED, SECTION_LABEL, WARN, MiniButton } from "../../shared/ui/kit";
import { ProviderIcon } from "../../shared/ui/provider-icon";
import { groupByCategory, readiness, type AdminProvider } from "./provider-utils";

const LINK_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-ring";

/** Provider catalogue list. Every row opens /admin/providers/:code. */
export function ProvidersAdmin({ client }: { client: PeridotClient }) {
  const [rows, setRows] = useState<AdminProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(unwrap(await client.get<AdminProvider[]>("/v1/admin/providers"), "Loading providers"));
    } catch (e) {
      setRows(null);
      setError(e instanceof Error ? e.message : "Could not load providers");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = rows ? groupByCategory(rows) : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Provider catalogue</p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              A provider is only a usable login choice when it has an implemented adapter, complete
              configuration and is enabled globally. Codes are immutable once apps reference them.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/admin/providers/new" className={LINK_BUTTON}>
              Add provider
            </Link>
            <MiniButton onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </MiniButton>
          </div>
        </div>
        {error && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
            <MiniButton onClick={() => void load()}>Retry</MiniButton>
          </div>
        )}
      </Card>

      {loading && !rows && (
        <Card>
          <p role="status" className={`text-sm ${MUTED}`}>Loading providers…</p>
        </Card>
      )}

      {groups && rows && rows.length === 0 && (
        <Card>
          <p className={`text-sm ${MUTED}`}>No providers registered yet.</p>
        </Card>
      )}

      {groups &&
        (["web2", "web3"] as const).map((group) => {
          const list = groups[group];
          if (list.length === 0) return null;
          return (
            <Card key={group}>
              <p className={SECTION_LABEL}>{group === "web2" ? "Web2" : "Web3"}</p>
              <ul className="mt-4 flex flex-col gap-px">
                {list.map((provider) => {
                  const state = readiness(provider);
                  return (
                    <li key={provider.code} className="border-t border-line first:border-t-0">
                      <Link
                        to={`/admin/providers/${provider.code}`}
                        className="focus-ring -mx-2 flex items-start justify-between gap-4 rounded-md px-2 py-3 transition-colors hover:bg-muted/40"
                      >
                        <span className="flex min-w-0 items-start gap-3">
                          <ProviderIcon provider={provider} />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">{provider.name}</span>
                            <span className="block font-mono text-xs text-muted-foreground">
                              {provider.code} · {provider.protocol}
                              {provider.adapter ? ` · ${provider.adapter}` : ""}
                            </span>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3 text-xs">
                          <span
                            className={
                              state.tone === "ready" ? "text-emerald-700 dark:text-emerald-300"
                                : state.tone === "warn" ? WARN : MUTED
                            }
                          >
                            {state.label}
                          </span>
                          <span className="text-muted-foreground transition-colors hover:text-foreground">Edit</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
    </div>
  );
}
