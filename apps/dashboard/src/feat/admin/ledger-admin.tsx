import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Badge, Card, ERROR, FIELD, METRIC, MUTED, SECTION_LABEL, WARN, MiniButton } from "../../shared/ui/kit";
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

/** Admin fiat ledger: platform replay, hash-chain integrity, per-PID journal. Read only. */
export function LedgerAdmin({ client }: { client: PeridotClient }) {
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [pid, setPid] = useState("");
  const [journal, setJournal] = useState<JournalView | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);

  // Ops actions: freeze, chain backfill, balanced adjustment.
  const [opsBusy, setOpsBusy] = useState<"freeze" | "backfill" | "adjust" | null>(null);
  const [opsMsg, setOpsMsg] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [freezeReason, setFreezeReason] = useState("");
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [adjust, setAdjust] = useState({ fromPid: "", toPid: "", amount: "", reason: "" });
  const [adjustKey, setAdjustKey] = useState<string | null>(null);
  const [confirmAdjust, setConfirmAdjust] = useState(false);

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

  const runFreeze = async (frozen: boolean) => {
    setOpsBusy("freeze");
    setOpsError(null);
    setOpsMsg(null);
    try {
      const res = unwrap(
        await client.post<{ frozen: boolean; reason: string | null }>("/v1/fiat/admin/freeze", {
          frozen,
          ...(freezeReason.trim() ? { reason: freezeReason.trim() } : {}),
        }),
        "Setting ledger freeze",
      );
      setOpsMsg(res.frozen ? "Ledger frozen — all fiat movement halted." : "Freeze cleared — fiat movement resumed.");
      setConfirmFreeze(false);
      setFreezeReason("");
      await load();
    } catch (e) {
      setOpsError(e instanceof Error ? e.message : "Could not change the freeze");
    } finally {
      setOpsBusy(null);
    }
  };

  const runBackfill = async () => {
    setOpsBusy("backfill");
    setOpsError(null);
    setOpsMsg(null);
    try {
      const res = unwrap(
        await client.post<{ chained: number }>("/v1/fiat/admin/chain/backfill", {}),
        "Backfilling the hash chain",
      );
      setOpsMsg(`${res.chained} posted row(s) chained.`);
      await load();
    } catch (e) {
      setOpsError(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setOpsBusy(null);
    }
  };

  const runAdjust = async () => {
    // One idempotency key per submission until it succeeds — a retried POST
    // after a lost response must not post a second pair.
    const key = adjustKey ?? `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (!adjustKey) setAdjustKey(key);
    setOpsBusy("adjust");
    setOpsError(null);
    setOpsMsg(null);
    try {
      const res = unwrap(
        await client.post<{ entryGroup: string }>("/v1/fiat/admin/adjust", {
          fromPid: adjust.fromPid.trim().toLowerCase(),
          toPid: adjust.toPid.trim().toLowerCase(),
          amountIdr: adjust.amount.trim(),
          reason: adjust.reason.trim(),
          requestId: key,
        }),
        "Posting adjustment",
      );
      setOpsMsg(`Adjustment posted: ${res.entryGroup}`);
      setAdjust({ fromPid: "", toPid: "", amount: "", reason: "" });
      setAdjustKey(null);
      setConfirmAdjust(false);
      await load();
    } catch (e) {
      setOpsError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setOpsBusy(null);
    }
  };

  const adjustValid =
    /^[a-z0-9_]+@pid$/.test(adjust.fromPid.trim().toLowerCase()) &&
    /^[a-z0-9_]+@pid$/.test(adjust.toPid.trim().toLowerCase()) &&
    adjust.fromPid.trim().toLowerCase() !== adjust.toPid.trim().toLowerCase() &&
    /^\d+$/.test(adjust.amount.trim()) &&
    Number(adjust.amount.trim()) > 0 &&
    adjust.reason.trim().length >= 8;

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
              <p className={WARN}>{chain.postedUnchained} posted row(s) unchained — run the backfill below.</p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Operations</p>
        <div className="mt-3 flex flex-col gap-4 text-xs">
          <div className="flex flex-col gap-2">
            <p>
              Freeze switch — halts all fiat movement (deposits, sends, adjustments) while engaged.
              {replay && <span className={`ml-2 ${replay.frozen ? WARN : MUTED}`}>{replay.frozen ? "currently frozen" : "currently open"}</span>}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Reason (optional)
                <input className={FIELD} value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} placeholder="incident / runbook ref" />
              </label>
              {confirmFreeze ? (
                <>
                  <MiniButton
                    variant="solid"
                    onClick={() => void runFreeze(!replay?.frozen)}
                    disabled={opsBusy === "freeze"}
                  >
                    {opsBusy === "freeze" ? "Working…" : replay?.frozen ? "Confirm clear freeze" : "Confirm freeze"}
                  </MiniButton>
                  <MiniButton onClick={() => setConfirmFreeze(false)} disabled={opsBusy === "freeze"}>Cancel</MiniButton>
                </>
              ) : (
                <MiniButton onClick={() => setConfirmFreeze(true)} disabled={!replay || opsBusy === "freeze"}>
                  {replay?.frozen ? "Clear freeze" : "Freeze ledger"}
                </MiniButton>
              )}
            </div>
          </div>
          {chain && chain.postedUnchained > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <MiniButton onClick={() => void runBackfill()} disabled={opsBusy === "backfill"}>
                {opsBusy === "backfill" ? "Backfilling…" : "Backfill unchained rows"}
              </MiniButton>
              <span className={MUTED}>Fills NULL hashes only — never rewrites a chained row.</span>
            </div>
          )}
          {opsMsg && <p role="status" className="text-emerald-300">{opsMsg}</p>}
          {opsError && <p role="alert" className={ERROR}>{opsError}</p>}
        </div>
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Adjustment — balanced correction (audited)</p>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Debits <span className="font-mono">fromPid</span> and credits <span className="font-mono">toPid</span> with the same amount, one entry group,
          immutable once posted. The sender balance is rechecked inside the transaction.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs">
            From PID (debited)
            <input
              className={`${FIELD} font-mono`}
              value={adjust.fromPid}
              onChange={(e) => setAdjust({ ...adjust, fromPid: e.target.value })}
              placeholder="sender@pid"
            />
          </label>
          <label className="text-xs">
            To PID (credited)
            <input
              className={`${FIELD} font-mono`}
              value={adjust.toPid}
              onChange={(e) => setAdjust({ ...adjust, toPid: e.target.value })}
              placeholder="recipient@pid"
            />
          </label>
          <label className="text-xs">
            Amount (whole IDR)
            <input
              className={`${FIELD} font-mono`}
              inputMode="numeric"
              value={adjust.amount}
              onChange={(e) => setAdjust({ ...adjust, amount: e.target.value.replace(/\D/g, "") })}
              placeholder="10000"
            />
          </label>
          <label className="text-xs">
            Reason (min 8 chars, audited)
            <input
              className={FIELD}
              value={adjust.reason}
              onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}
              placeholder="reversal of duplicate send"
            />
          </label>
        </div>
        {confirmAdjust ? (
          <div className="mt-3 flex flex-col gap-2 text-xs">
            <p className={WARN}>
              Post now? {adjust.amount} IDR from {adjust.fromPid.trim().toLowerCase()} to {adjust.toPid.trim().toLowerCase()} — this moves real ledger money and cannot be undone.
            </p>
            <div className="flex items-center gap-2">
              <MiniButton variant="solid" onClick={() => void runAdjust()} disabled={opsBusy === "adjust"}>
                {opsBusy === "adjust" ? "Posting…" : "Post adjustment"}
              </MiniButton>
              <MiniButton onClick={() => setConfirmAdjust(false)} disabled={opsBusy === "adjust"}>Cancel</MiniButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <MiniButton onClick={() => setConfirmAdjust(true)} disabled={!adjustValid || opsBusy === "adjust"}>
              Review adjustment
            </MiniButton>
            <span className={MUTED}>Requires two PIDs, a positive whole-IDR amount and a reason.</span>
          </div>
        )}
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
