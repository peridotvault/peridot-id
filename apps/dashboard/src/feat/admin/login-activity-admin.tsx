import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../workspace/api";
import { Card, ERROR, FIELD, MUTED, SECTION_LABEL, MiniButton } from "../../workspace/ui";
import type { ProviderMeta } from "../../workspace/app-types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../shared/ui/table";

interface LoginEventRow {
  id: string;
  appId: string;
  pid: string;
  occurredAt: string;
  providerEvidence: "server" | "client_selected" | "unknown" | null;
  app: { id: string; name: string; clientId: string } | null;
  provider: { code: string; name: string; imageUrl: string | null; category: string } | null;
}

interface LoginHistory {
  events: LoginEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

const EVIDENCE = ["server", "client_selected", "unknown"] as const;

/** Admin login history: filter by app, PID, provider, evidence and time. */
export function LoginActivityAdmin({ client }: { client: PeridotClient }) {
  const [data, setData] = useState<LoginHistory | null>(null);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [appId, setAppId] = useState("");
  const [pid, setPid] = useState("");
  const [provider, setProvider] = useState("");
  const [evidence, setEvidence] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ page: String(targetPage) });
      if (appId.trim()) params.set("appId", appId.trim());
      if (pid.trim()) params.set("pid", pid.trim());
      if (provider) params.set("provider", provider);
      if (evidence) params.set("evidence", evidence);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      try {
        setData(unwrap(await client.get<LoginHistory>(`/v1/admin/logins?${params.toString()}`), "Loading login history"));
      } catch (e) {
        setData(null);
        setError(e instanceof Error ? e.message : "Could not load login history");
      } finally {
        setLoading(false);
      }
    },
    [client, appId, pid, provider, evidence, from, to],
  );

  useEffect(() => {
    void client
      .get<ProviderMeta[]>("/v1/providers")
      .then((res) => setProviders(unwrap(res, "Loading providers")))
      .catch(() => setProviders([]));
  }, [client]);

  // Filters apply explicitly (Apply filters); only pagination auto-fetches.
  useEffect(() => {
    void load(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <p className={SECTION_LABEL}>Filters</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs">
            App ID
            <input className={`${FIELD} font-mono`} value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="app UUID" />
          </label>
          <label className="text-xs">
            PID
            <input className={`${FIELD} font-mono`} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="ifal@pid" />
          </label>
          <label className="text-xs">
            Provider
            <select className={FIELD} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">Any</option>
              {providers.map((p) => (
                <option key={p.code} value={p.code}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Evidence
            <select className={FIELD} value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              <option value="">Any</option>
              {EVIDENCE.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            From
            <input className={FIELD} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-xs">
            To
            <input className={FIELD} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <MiniButton variant="solid" onClick={() => { setPage(1); void load(1); }} disabled={loading}>
            {loading ? "Loading…" : "Apply filters"}
          </MiniButton>
          <MiniButton
            onClick={() => {
              setAppId("");
              setPid("");
              setProvider("");
              setEvidence("");
              setFrom("");
              setTo("");
              setPage(1);
            }}
            disabled={loading}
          >
            Clear
          </MiniButton>
        </div>
        {error && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
            <MiniButton onClick={() => void load(page)}>Retry</MiniButton>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SECTION_LABEL}>Login history</p>
          <p className={`text-xs ${MUTED}`}>{data ? `${data.total} events` : ""}</p>
        </div>
        {!data && loading && <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading events…</p>}
        {data?.events.length === 0 && <p className={`mt-3 text-sm ${MUTED}`}>No login events match these filters.</p>}
        {data && data.events.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <Table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="py-2 pr-3 font-medium">Time</TableHead>
                  <TableHead className="py-2 pr-3 font-medium">App</TableHead>
                  <TableHead className="py-2 pr-3 font-medium">PID</TableHead>
                  <TableHead className="py-2 pr-3 font-medium">Provider</TableHead>
                  <TableHead className="py-2 pr-3 font-medium">Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.map((event) => (
                  <TableRow key={event.id} className="border-b border-line/60">
                    <TableCell className="py-2 pr-3 font-mono">{new Date(event.occurredAt).toLocaleString()}</TableCell>
                    <TableCell className="py-2 pr-3">{event.app?.name ?? event.appId}</TableCell>
                    <TableCell className="py-2 pr-3 font-mono">{event.pid}</TableCell>
                    <TableCell className="py-2 pr-3">{event.provider?.name ?? "—"}</TableCell>
                    <TableCell className={`py-2 pr-3 ${event.providerEvidence === "unknown" || !event.providerEvidence ? "text-amber-700 dark:text-amber-300" : ""}`}>
                      {event.providerEvidence ?? "unknown"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > data.pageSize && (
          <div className="mt-3 flex items-center gap-2">
            <MiniButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
              Previous
            </MiniButton>
            <span className={`text-xs ${MUTED}`}>Page {page} of {totalPages}</span>
            <MiniButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
              Next
            </MiniButton>
          </div>
        )}
      </Card>
    </div>
  );
}
