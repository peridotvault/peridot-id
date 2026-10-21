
import { Link } from "react-router";
import { useNavigate, useSearchParams } from "react-router";
import { useCallback, useEffect, useState } from "react";
import type { Chain } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../workspace/api";
import { EditChainForm } from "../workspace/edit-chain-form";
import { PageHeader } from "../workspace/page-header";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED, MiniButton } from "../workspace/ui";

export function EditChainView() {
  const { client, status, isAdmin } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
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

  // Inline retry next to the error: without this the only recovery is a full
  // page reload. Same load path as the initial fetch.
  const retry = useCallback(() => {
    if (!isAdmin || !id) return;
    setLoading(true);
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load chain"))
      .finally(() => setLoading(false));
  }, [load, isAdmin, id]);

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`text-sm ${MUTED}`}>
          Admin only. <Link to="/" className="underline">Back to workspace</Link>
        </p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <PageHeader
        eyebrow="Chain registry"
        title="Edit chain"
        description="Update metadata, RPCs, and availability for this chain."
      />
      <div className="mt-4">
        {loading ? (
          <p role="status" className={`text-sm ${MUTED}`}>Loading…</p>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm ${ERROR}`}>{error}</p>
            <MiniButton size="sm" onClick={retry}>
              Retry
            </MiniButton>
          </div>
        ) : !id || !chain ? (
          <p className={`text-sm ${MUTED}`}>
            Chain not found. <Link to="/chains" className="underline">Back to chains</Link>
          </p>
        ) : (
          <Card>
            <EditChainForm client={client} chain={chain} onDone={() => navigate("/chains")} />
          </Card>
        )}
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link to="/chains" className="underline">Back to chains</Link>
      </p>
    </main>
  );
}
