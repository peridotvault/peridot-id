import { useState } from "react";
import { Link } from "react-router";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { MIN_JUSTIFICATION, formatXp, grantEnvelopeStatus } from "../leveling/xp";
import { xpAdmin } from "../leveling/api";

/**
 * Settings: progression defaults (active policy + draft), earning limits
 * (org quotas), fraud flags (suspicious review shortcut + suspend), and
 * visibility defaults (F1 GA decision — explicitly pending, no fake controls).
 */
export default function LevelingSettingsPage() {
  const { client } = useWorkspace();
  const { data: policies, loading, error, reload } = useResource(() => xpAdmin.listPolicies(client), [client]);
  const active = policies?.find((p) => p.active) ?? null;

  return (
    <LevelingLayout active="settings">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      <div className="flex flex-col gap-4">
        <Card>
          <h2 className="text-lg font-semibold tracking-tight">Progression defaults</h2>
          {loading ? (
            <p role="status" className={`mt-2 text-sm ${MUTED}`}>Loading policies…</p>
          ) : !active ? (
            <p className={`mt-2 text-sm ${MUTED}`}>
              No active policy. Draft and activate one from the <Link className="underline" to="/leveling/levels">Levels</Link> page.
            </p>
          ) : (
            <p className="mt-2 text-sm">
              Active <span className="font-medium">v{active.version}</span>
              <span className={`text-sm ${MUTED}`}>
                {" "}· floor({active.formula.base}·L^{active.formula.exponent}) · max level {active.maxLevel ?? "—"} · {formatXp(active.thresholdCount)} thresholds
              </span>
            </p>
          )}
        </Card>

        <OrgQuotaCard />

        <Card>
          <h2 className="text-lg font-semibold tracking-tight">Fraud flags</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Self-grant alerts and abuse signals land in suspicious activity; abusive apps are
            suspended from the Applications page (awards short-circuit while suspended).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/leveling">
              <MiniButton size="sm">Review suspicious activity</MiniButton>
            </Link>
            <Link to="/leveling/apps">
              <MiniButton size="sm">Open Applications</MiniButton>
            </Link>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold tracking-tight">Visibility defaults</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Pending GA decision (plan §13 F1): per-user visibility defaults, per-app read caps, and
            enumeration throttling must be specified before M3 so the event pipeline does not inherit
            the MVP-open read by accident. Reads stay open through M1/M2 by design — no controls are
            rendered here until that decision lands.
          </p>
        </Card>
      </div>
    </LevelingLayout>
  );
}

function OrgQuotaCard() {
  const { client } = useWorkspace();
  const [ownerPid, setOwnerPid] = useState("");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [monthly, setMonthly] = useState("");
  const [confirmedBy, setConfirmedBy] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const verdict = grantEnvelopeStatus({ isRaise: true, confirmedBy, reason });

  const submit = async () => {
    if (!ownerPid.trim()) {
      setMsg({ ok: false, text: "Owner PID is required." });
      return;
    }
    if (!verdict.ok) {
      setMsg({ ok: false, text: verdict.error });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const cap = (v: string): number | null | undefined => {
        const t = v.trim();
        if (!t) return undefined;
        if (t === "0") return null;
        const n = Number(t);
        if (!Number.isInteger(n) || n < 1) throw new Error("Caps must be positive integers (blank = unchanged, 0 = clear).");
        return n;
      };
      await xpAdmin.upsertOrgQuota(client, ownerPid.trim(), {
        dailyCap: cap(daily),
        weeklyCap: cap(weekly),
        monthlyCap: cap(monthly),
        confirmedBy: confirmedBy.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      setMsg({ ok: true, text: `Org quota saved for ${ownerPid.trim()} (aggregate across that owner's apps).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Earning limits — organization quotas</h2>
      <p className={`mt-1 text-sm ${MUTED}`}>
        Cap aggregate XP across every app of one developer org (keyed by owner PID). Raising a cap
        needs a second-person confirm or a justification (≥ {MIN_JUSTIFICATION} chars). Blank = unchanged, 0 = clear.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">Owner PID
          <input aria-label="Org owner PID" className={FIELD} value={ownerPid} onChange={(e) => setOwnerPid(e.target.value)} placeholder="developer@pid" />
        </label>
        <label className="text-xs">Daily cap<input aria-label="Org daily cap" className={FIELD} value={daily} inputMode="numeric" onChange={(e) => setDaily(e.target.value)} placeholder="—" /></label>
        <label className="text-xs">Weekly cap<input aria-label="Org weekly cap" className={FIELD} value={weekly} inputMode="numeric" onChange={(e) => setWeekly(e.target.value)} placeholder="—" /></label>
        <label className="text-xs">Monthly cap<input aria-label="Org monthly cap" className={FIELD} value={monthly} inputMode="numeric" onChange={(e) => setMonthly(e.target.value)} placeholder="—" /></label>
        <label className="text-xs">Second-person confirm (admin PID)
          <input aria-label="Org quota confirming admin" className={FIELD} value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} placeholder="peer-admin@pid" />
        </label>
        <label className="text-xs sm:col-span-2">Justification (or-confirm)
          <input aria-label="Org quota justification" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why raise these caps…" />
        </label>
      </div>
      <div className="mt-3">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Saving…" : "Save org quota"}
        </MiniButton>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? MUTED : ERROR}`}>{msg.text}</p>}
    </Card>
  );
}
