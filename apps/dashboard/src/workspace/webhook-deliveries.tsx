import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, ERROR, MUTED, SECTION_LABEL, MiniButton } from "./ui";

type Delivery = { id: string; eventType: string; status: string; attempts: number; createdAt: string; lastError: string | null };
export function WebhookDeliveries({ client, appId }: { client: PeridotClient; appId: string }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setRows(unwrap(await client.get<Delivery[]>(`/v1/apps/${appId}/webhook/deliveries`), "Load deliveries")); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load deliveries"); }
    finally { setLoading(false); }
  }, [client, appId]);
  useEffect(() => { void load(); }, [load]);
  const replay = async (id: string) => {
    setBusy(id); setError(null);
    try {
      unwrap(await client.post(`/v1/apps/${appId}/webhook/deliveries/${id}/replay`, {}), "Replay delivery");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Replay failed"); }
    finally { setBusy(null); }
  };
  return <Card className="border-t-0">
    <div className="flex items-center justify-between gap-4">
      <h2 className={SECTION_LABEL}>Webhook deliveries</h2>
      <MiniButton className="min-h-10" disabled={loading} onClick={() => void load()}>Refresh</MiniButton>
    </div>
    {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
    {loading ? <p role="status" className={`mt-4 ${MUTED}`}>Loading deliveries…</p> : rows.length === 0 ?
      <p className={`mt-4 text-sm ${MUTED}`}>No events yet. Payments and transfers will appear here once posted.</p> :
      <ul className="mt-4 divide-y divide-current/10">{rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm">{row.eventType}</p>
          <p className={`mt-1 break-all font-mono text-xs ${MUTED}`}>{row.id}</p>
          <p className={`mt-1 text-xs ${MUTED}`}>{row.status} · {row.attempts} attempts · {new Date(row.createdAt).toLocaleString()}</p>
          {row.lastError && <p className={`mt-1 break-words text-xs ${ERROR}`}>{row.lastError}</p>}
        </div>
        <MiniButton className="min-h-10" disabled={busy !== null} aria-label={`Replay ${row.eventType} ${row.id}`} onClick={() => void replay(row.id)}>{busy === row.id ? "Queuing…" : "Replay"}</MiniButton>
      </li>)}</ul>}
  </Card>;
}
