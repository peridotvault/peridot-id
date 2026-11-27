import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Badge, Card, DANGER, ERROR, FIELD, METRIC, MUTED, SECTION_LABEL, WARN, MiniButton } from "../../shared/ui/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../shared/ui/table";

interface ReplayView {
  enabled: boolean;
  frozen: boolean;
  treasuryPid: string | null;
  rows: number;
  truncated: boolean;
  outstandingIdr: string;
  treasuryIdr: string;
  taxIdr: string;
  balances: Record<string, string>;
  inFlight: number;
  errors: string[];
}

interface ChainView {
  ok: boolean;
  checked: number;
  headHash: string;
  firstBadIdempotencyKey: string | null;
  error: string | null;
  postedUnchained: number;
}

interface JournalRow {
  id: string;
  kind: string;
  entryGroup: string;
  counterpartyPid: string | null;
  amountIdr: string;
  direction: string;
  status: string;
  createdAt: string;
}

interface JournalView {
  pid: string;
  balanceIdr: string;
  truncated: boolean;
  inFlight: string[];
  errors: string[];
  rows: JournalRow[];
}

const fmtIdr = (units: string) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(units));

/** Admin fiat ledger: platform replay, hash-chain integrity, per-PID journal. Read only —
 *  the freeze switch and adjustments live on `/admin/ledger/danger`. */
export function LedgerAdmin({ client }: { client: PeridotClient }) {
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [pid, setPid] = useState("");
  const [journal, setJournal] = useState<JournalView | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        client.get<ReplayView>("/v1/fiat/admin/replay"),
        client.get<ChainView>("/v1/fiat/admin/chain"),
      ]);
      setReplay(unwrap(r, "Loading ledger replay"));
      setChain(unwrap(c, "Verifying ledger chain"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the ledger");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadJournal = useCallback(async () => {
    const target = pid.trim().toLowerCase();
    if (!target) return;
    setJournalLoading(true);
    setJournalError(null);
    try {
      setJournal(unwrap(await client.get<JournalView>(`/v1/fiat/admin/journal/${encodeURIComponent(target)}`), "Loading journal"));
    } catch (e) {
      setJournal(null);
      setJournalError(e instanceof Error ? e.message : "Could not load the journal");
    } finally {
      setJournalLoading(false);
    }
  }, [client, pid]);

  const balances = replay ? Object.entries(replay.balances).sort((a, b) => Number(b[1]) - Number(a[1])) : [];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SECTION_LABEL}>Platform ledger</p>
          <div className="flex items-center gap-2">
            {replay && <Badge tone={replay.enabled ? "success" : "muted"}>{replay.enabled ? "issuance on" : "issuance off"}</Badge>}
            {replay?.frozen && <Badge tone="warning">frozen</Badge>}
            <MiniButton onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </MiniButton>
          </div>
        </div>
        {error && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
            <MiniButton onClick={() => void load()}>Retry</MiniButton>
          </div>
        )}
        {!replay && loading && <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading replay…</p>}
        {replay && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className={`text-xs ${MUTED}`}>Outstanding</p>
                <p className={`mt-1 text-lg ${METRIC}`}>{fmtIdr(replay.outstandingIdr)}</p>
              </div>
              <div>
                <p className={`text-xs ${MUTED}`}>Fees (treasury)</p>
                <p className={`mt-1 text-lg ${METRIC}`}>{fmtIdr(replay.treasuryIdr)}</p>
              </div>
              <div>
                <p className={`text-xs ${MUTED}`}>PPN (tax)</p>
                <p className={`mt-1 text-lg ${METRIC}`}>{fmtIdr(replay.taxIdr)}</p>
              </div>
              <div>
                <p className={`text-xs ${MUTED}`}>Rows replayed</p>
                <p className={`mt-1 text-lg ${METRIC}`}>{replay.rows}</p>
              </div>
            </div>
            {replay.truncated && (
              <p className={`mt-3 text-xs ${WARN}`}>Projection capped at the newest 5000 rows — totals are partial.</p>
            )}
            {replay.inFlight > 0 && <p className={`mt-1 text-xs ${MUTED}`}>{replay.inFlight} unposted row(s) in flight.</p>}
            {replay.errors.length > 0 && (
              <ul className={`mt-2 list-disc pl-5 text-xs ${ERROR}`}>
                {replay.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SECTION_LABEL}>Balances per PID — highest first</p>
          <p className={`text-xs ${MUTED}`}>{replay ? `${balances.length} owners` : ""}</p>
        </div>
        {balances.length === 0 && <p className={`mt-3 text-sm ${MUTED}`}>No ledger movements yet.</p>}
        {balances.length > 0 && (
          <div className="mt-3 max-h-[420px] overflow-auto">
            <Table className="w-full min-w-[420px] border-collapse text-left text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="py-2 pr-3">PID</TableHead>
                  <TableHead className="py-2 pr-3 text-right">Balance (IDR)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map(([owner, balance]) => (
                  <TableRow key={owner} className="border-b border-line/60">
                    <TableCell className="py-2 pr-3 font-mono">{owner}</TableCell>
                    <TableCell className="py-2 pr-3 text-right font-mono">{fmtIdr(balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Hash-chain integrity</p>
        {!chain && loading && <p role="status" className={`mt-3 text-sm ${MUTED}`}>Verifying…</p>}
        {chain && (
          <div className="mt-3 flex flex-col gap-2 text-xs">
            <p>
              {chain.ok ? <Badge tone="success">chain valid</Badge> : <Badge tone="danger">chain broken</Badge>}
              <span className={`ml-2 ${MUTED}`}>{chain.checked} posted row(s) verified</span>
            </p>
            <p className={`break-all font-mono ${MUTED}`}>head {chain.headHash}</p>
            {chain.firstBadIdempotencyKey && <p className={ERROR}>first bad row: {chain.firstBadIdempotencyKey}</p>}
            {chain.error && <p className={ERROR}>{chain.error}</p>}
            {chain.postedUnchained > 0 && (
              <p className={WARN}>{chain.postedUnchained} posted row(s) unchained — run the backfill on the danger page.</p>
            )}
          </div>
        )}
      </Card>

      <Card className="border-destructive/40">
        <p className={`${SECTION_LABEL} ${DANGER}`}>Danger zone</p>
        <p className={`mt-1 text-xs ${MUTED}`}>Freeze switch, chain backfill and balanced adjustments move real ledger money.</p>
        <Link to="/admin/ledger/danger" className={`mt-3 inline-block text-sm ${DANGER} transition-opacity hover:opacity-80`}>
          Open ledger operations →
        </Link>
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Journal by PID</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            PID
            <input
              className={`${FIELD} font-mono`}
              value={pid}
              onChange={(e) => setPid(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void loadJournal(); }}
              placeholder="ifal@pid"
            />
          </label>
          <MiniButton variant="solid" onClick={() => void loadJournal()} disabled={journalLoading || !pid.trim()}>
            {journalLoading ? "Loading…" : "Load journal"}
          </MiniButton>
        </div>
        {journalError && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{journalError}</p>}
        {journal && (
          <>
            <p className={`mt-3 text-sm`}>
              Balance <span className={METRIC}>{fmtIdr(journal.balanceIdr)}</span>
              <span className={`ml-2 text-xs ${MUTED}`}>{journal.rows.length} row(s){journal.truncated ? " (truncated)" : ""}</span>
            </p>
            {journal.errors.length > 0 && (
              <ul className={`mt-2 list-disc pl-5 text-xs ${ERROR}`}>
                {journal.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            {journal.rows.length === 0 && <p className={`mt-2 text-sm ${MUTED}`}>No journal rows for this PID.</p>}
            {journal.rows.length > 0 && (
              <div className="mt-3 max-h-[420px] overflow-auto">
                <Table className="w-full min-w-[720px] border-collapse text-left text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="py-2 pr-3">Time</TableHead>
                      <TableHead className="py-2 pr-3">Kind</TableHead>
                      <TableHead className="py-2 pr-3 text-right">Amount (IDR)</TableHead>
                      <TableHead className="py-2 pr-3">Dir</TableHead>
                      <TableHead className="py-2 pr-3">Status</TableHead>
                      <TableHead className="py-2 pr-3">Counterparty</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journal.rows.map((row) => (
                      <TableRow key={row.id} className="border-b border-line/60">
                        <TableCell className="py-2 pr-3 font-mono">{new Date(row.createdAt).toLocaleString()}</TableCell>
                        <TableCell className="py-2 pr-3">{row.kind}</TableCell>
                        <TableCell className="py-2 pr-3 text-right font-mono">
                          {row.direction === "out" ? "-" : ""}{fmtIdr(row.amountIdr)}
                        </TableCell>
                        <TableCell className="py-2 pr-3">{row.direction}</TableCell>
                        <TableCell className="py-2 pr-3">{row.status}</TableCell>
                        <TableCell className="py-2 pr-3 font-mono">{row.counterpartyPid ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
