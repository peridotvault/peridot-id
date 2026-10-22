import { useState } from "react";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { LEDGER_KINDS, formatXp } from "../leveling/xp";
import { xpAdmin, type LedgerEntry } from "../leveling/api";

/** XP History: filterable audit table + manual adjust / reverse (reason required, server-enforced). */
export default function LevelingHistoryPage() {
  const { client } = useWorkspace();
  const [pid, setPid] = useState("");
  const [kind, setKind] = useState("");
  const [applied, setApplied] = useState({ pid: "", kind: "" });
  const { data, loading, error, reload } = useResource(
    () => xpAdmin.ledger(client, { pid: applied.pid || undefined, kind: applied.kind || undefined, limit: 50 }),
    [client, applied],
  );

  return (
    <LevelingLayout active="history">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <AdjustForm onDone={reload} />
          <ReverseForm onDone={reload} />
        </div>
        <Card>
          <h2 className="text-lg font-semibold tracking-tight">Audit table</h2>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs">PID
              <input aria-label="Filter by PID" className={FIELD} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="user@pid" />
            </label>
            <label className="text-xs">Kind
              <select aria-label="Filter by kind" className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All</option>
                {LEDGER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <MiniButton size="sm" variant="solid" onClick={() => setApplied({ pid: pid.trim(), kind })}>Apply</MiniButton>
            <MiniButton size="sm" onClick={() => { setPid(""); setKind(""); setApplied({ pid: "", kind: "" }); }}>Clear</MiniButton>
          </div>
          {loading ? (
            <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading history…</p>
          ) : !data || data.rows.length === 0 ? (
            <p className={`mt-3 text-sm ${MUTED}`}>No entries match these filters.</p>
          ) : (
            <>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className={`border-b border-border text-left text-xs uppercase tracking-wide ${MUTED}`}>
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">PID</th>
                      <th className="py-2 pr-3">Kind</th>
                      <th className="py-2 pr-3 text-right">Δ XP</th>
                      <th className="py-2 pr-3 text-right">Balance</th>
                      <th className="py-2 pr-3">Reason / actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((e) => (
                      <LedgerRow key={e.id} entry={e} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={`mt-2 text-xs ${MUTED}`}>{data.total} total entries.</p>
            </>
          )}
        </Card>
      </div>
    </LevelingLayout>
  );
}

function LedgerRow({ entry: e }: { entry: LedgerEntry }) {
  return (
    <tr className="border-b border-dotted border-border align-top">
      <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{new Date(e.createdAt).toLocaleString()}</td>
      <td className="max-w-[140px] truncate py-1.5 pr-3" title={e.pid}>{e.pid}</td>
      <td className="py-1.5 pr-3">{e.kind}</td>
      <td className="py-1.5 pr-3 text-right font-medium">
        {e.deltaXp.startsWith("-") ? "" : "+"}{formatXp(e.deltaXp)}
      </td>
      <td className="py-1.5 pr-3 text-right">{formatXp(e.balanceAfter)}</td>
      <td className="max-w-[220px] py-1.5 pr-3 text-xs">
        <span className="block truncate" title={e.reason ?? ""}>{e.reason ?? "—"}</span>
        <span className={MUTED}>{e.actorAdminId ?? ""}{e.levelAfter ? ` · L${e.levelAfter}` : ""}</span>
      </td>
    </tr>
  );
}

function AdjustForm({ onDone }: { onDone: () => void }) {
  const { client } = useWorkspace();
  const [pid, setPid] = useState("");
  const [deltaXp, setDeltaXp] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!pid.trim()) throw new Error("PID is required.");
      if (reason.trim().length < 3) throw new Error("Reason is required (≥ 3 chars) — the server rejects empty reasons.");
      await xpAdmin.adjust(client, { pid: pid.trim(), deltaXp: Number(deltaXp), reason: reason.trim() });
      setMsg({ ok: true, text: "Adjustment applied and audited." });
      setPid("");
      setDeltaXp("");
      setReason("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Adjustment failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Manual adjustment</h2>
      <p className={`mt-1 text-sm ${MUTED}`}>Positive grants only; use Reverse for deductions. Reason is required.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">PID<input aria-label="Adjust PID" className={FIELD} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="user@pid" /></label>
        <label className="text-xs">XP amount<input aria-label="Adjust XP amount" className={FIELD} value={deltaXp} inputMode="numeric" onChange={(e) => setDeltaXp(e.target.value)} placeholder="100" /></label>
      </div>
      <label className="mt-2 block text-xs">Reason (required)
        <input aria-label="Adjust reason" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Support ticket #123…" />
      </label>
      <div className="mt-3">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Applying…" : "Apply adjustment"}
        </MiniButton>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? MUTED : ERROR}`}>{msg.text}</p>}
    </Card>
  );
}

function ReverseForm({ onDone }: { onDone: () => void }) {
  const { client } = useWorkspace();
  const [pid, setPid] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [originalEntryId, setOriginalEntryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!pid.trim()) throw new Error("PID is required.");
      if (reason.trim().length < 3) throw new Error("Reason is required (≥ 3 chars) — the server rejects empty reasons.");
      await xpAdmin.reverse(client, {
        pid: pid.trim(),
        amount: Number(amount),
        reason: reason.trim(),
        ...(originalEntryId.trim() ? { originalEntryId: originalEntryId.trim() } : {}),
      });
      setMsg({ ok: true, text: "Reversal recorded as a new negative entry — history is append-only." });
      setPid("");
      setAmount("");
      setReason("");
      setOriginalEntryId("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Reversal failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Reverse XP</h2>
      <p className={`mt-1 text-sm ${MUTED}`}>Writes a new negative entry; the original is never edited or deleted.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">PID<input aria-label="Reverse PID" className={FIELD} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="user@pid" /></label>
        <label className="text-xs">Amount<input aria-label="Reverse amount" className={FIELD} value={amount} inputMode="numeric" onChange={(e) => setAmount(e.target.value)} placeholder="50" /></label>
      </div>
      <label className="mt-2 block text-xs">Original entry ID (optional audit link)
        <input aria-label="Original entry ID" className={FIELD} value={originalEntryId} onChange={(e) => setOriginalEntryId(e.target.value)} placeholder="—" />
      </label>
      <label className="mt-2 block text-xs">Reason (required)
        <input aria-label="Reverse reason" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Fraudulent award…" />
      </label>
      <div className="mt-3">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Applying…" : "Apply reversal"}
        </MiniButton>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? MUTED : ERROR}`}>{msg.text}</p>}
    </Card>
  );
}
