import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, DANGER, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "../../shared/ui/kit";

interface ReplayView {
  frozen: boolean;
}

interface ChainView {
  postedUnchained: number;
}

/** Ledger danger zone: freeze switch, chain backfill and balanced adjustment.
 *  Every action here moves real fiat ledger state, so it lives on its own page. */
export function LedgerDanger({ client }: { client: PeridotClient }) {
  const [frozen, setFrozen] = useState<boolean | null>(null);
  const [unchained, setUnchained] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<"freeze" | "backfill" | "adjust" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freezeReason, setFreezeReason] = useState("");
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [adjust, setAdjust] = useState({ fromPid: "", toPid: "", amount: "", reason: "" });
  const [adjustKey, setAdjustKey] = useState<string | null>(null);
  const [confirmAdjust, setConfirmAdjust] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [r, c] = await Promise.all([
        client.get<ReplayView>("/v1/fiat/admin/replay"),
        client.get<ChainView>("/v1/fiat/admin/chain"),
      ]);
      setFrozen(unwrap(r, "Loading ledger state").frozen);
      setUnchained(unwrap(c, "Verifying ledger chain").postedUnchained);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the ledger state");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const runFreeze = async (next: boolean) => {
    setBusy("freeze");
    setError(null);
    setMsg(null);
    try {
      const res = unwrap(
        await client.post<{ frozen: boolean; reason: string | null }>("/v1/fiat/admin/freeze", {
          frozen: next,
          ...(freezeReason.trim() ? { reason: freezeReason.trim() } : {}),
        }),
        "Setting ledger freeze",
      );
      setMsg(res.frozen ? "Ledger frozen — all fiat movement halted." : "Freeze cleared — fiat movement resumed.");
      setConfirmFreeze(false);
      setFreezeReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the freeze");
    } finally {
      setBusy(null);
    }
  };

  const runBackfill = async () => {
    setBusy("backfill");
    setError(null);
    setMsg(null);
    try {
      const res = unwrap(
        await client.post<{ chained: number }>("/v1/fiat/admin/chain/backfill", {}),
        "Backfilling the hash chain",
      );
      setMsg(`${res.chained} posted row(s) chained.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBusy(null);
    }
  };

  const runAdjust = async () => {
    // One idempotency key per submission until it succeeds — a retried POST
    // after a lost response must not post a second pair.
    const key = adjustKey ?? `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (!adjustKey) setAdjustKey(key);
    setBusy("adjust");
    setError(null);
    setMsg(null);
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
      setMsg(`Adjustment posted: ${res.entryGroup}`);
      setAdjust({ fromPid: "", toPid: "", amount: "", reason: "" });
      setAdjustKey(null);
      setConfirmAdjust(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setBusy(null);
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
      {loadError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{loadError}</p>
          <MiniButton onClick={() => void load()}>Retry</MiniButton>
        </div>
      )}

      <Card className="border-destructive/40">
        <p className={`${SECTION_LABEL} ${DANGER}`}>Freeze switch</p>
        <p className={`mt-1 text-xs ${MUTED}`}>Halts all fiat movement (deposits, sends, adjustments) while engaged.</p>
        <p className="mt-2 text-xs">
          {frozen === null ? <span className={MUTED}>Checking…</span> : frozen ? <span className={WARN}>currently frozen</span> : <span className={MUTED}>currently open</span>}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Reason (optional)
            <input className={FIELD} value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} placeholder="incident / runbook ref" />
          </label>
          {confirmFreeze ? (
            <>
              <MiniButton variant="dangerSolid" onClick={() => void runFreeze(!frozen)} disabled={busy === "freeze"}>
                {busy === "freeze" ? "Working…" : frozen ? "Confirm clear freeze" : "Confirm freeze"}
              </MiniButton>
              <MiniButton onClick={() => setConfirmFreeze(false)} disabled={busy === "freeze"}>Cancel</MiniButton>
            </>
          ) : (
            <MiniButton variant="danger" onClick={() => setConfirmFreeze(true)} disabled={frozen === null || busy === "freeze"}>
              {frozen ? "Clear freeze" : "Freeze ledger"}
            </MiniButton>
          )}
        </div>
      </Card>

      {unchained > 0 && (
        <Card className="border-destructive/40">
          <p className={`${SECTION_LABEL} ${DANGER}`}>Hash-chain backfill</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <MiniButton onClick={() => void runBackfill()} disabled={busy === "backfill"}>
              {busy === "backfill" ? "Backfilling…" : `Backfill ${unchained} unchained row(s)`}
            </MiniButton>
            <span className={MUTED}>Fills NULL hashes only — never rewrites a chained row.</span>
          </div>
        </Card>
      )}

      <Card className="border-destructive/40">
        <p className={`${SECTION_LABEL} ${DANGER}`}>Adjustment — balanced correction (audited)</p>
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
              <MiniButton variant="dangerSolid" onClick={() => void runAdjust()} disabled={busy === "adjust"}>
                {busy === "adjust" ? "Posting…" : "Post adjustment"}
              </MiniButton>
              <MiniButton onClick={() => setConfirmAdjust(false)} disabled={busy === "adjust"}>Cancel</MiniButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <MiniButton variant="danger" onClick={() => setConfirmAdjust(true)} disabled={!adjustValid || busy === "adjust"}>
              Review adjustment
            </MiniButton>
            <span className={MUTED}>Requires two PIDs, a positive whole-IDR amount and a reason.</span>
          </div>
        )}
      </Card>

      {msg && <p role="status" className="text-sm text-emerald-300">{msg}</p>}
      {error && <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>}
    </div>
  );
}
