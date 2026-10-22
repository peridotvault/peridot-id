import { useState } from "react";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { buildThresholds, formatXp, grantEnvelopeStatus } from "../leveling/xp";
import { xpAdmin } from "../leveling/api";

/**
 * Levels: formula/threshold table, max-level, client simulator + server
 * impact preview, and the activation review gate (second-person confirm or
 * justification — F3; the server re-checks the envelope).
 */
export default function LevelingLevelsPage() {
  const { client } = useWorkspace();
  const { data: policies, loading, error, reload } = useResource(() => xpAdmin.listPolicies(client), [client]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const active = policies?.find((p) => p.active) ?? null;
  const selected = policies?.find((p) => p.id === (selectedId ?? active?.id)) ?? active;

  return (
    <LevelingLayout active="levels">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      {loading ? (
        <p role="status" className={`text-sm ${MUTED}`}>Loading policies…</p>
      ) : !policies || policies.length === 0 ? (
        <Card>
          <h2 className="text-lg font-semibold tracking-tight">No policy versions</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>Draft the first progression policy below to start versioning.</p>
          <div className="mt-4"><PolicyDraftForm onDone={reload} /></div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="text-lg font-semibold tracking-tight">Policy versions</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {policies.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    aria-pressed={selected?.id === p.id}
                    className={`flex w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-ring ${
                      selected?.id === p.id ? "border-foreground" : "border-border hover:border-foreground/50"
                    }`}
                  >
                    <span className="font-medium">v{p.version}</span>
                    {p.active && (
                      <span className="rounded-[3px] bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                        active
                      </span>
                    )}
                    <span className={`text-xs ${MUTED}`}>
                      base {p.formula.base} · exp {p.formula.exponent} · max {p.maxLevel ?? "—"} · {p.thresholdCount} thresholds
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4"><PolicyDraftForm onDone={reload} /></div>
          </Card>

          {selected && (
            <>
              <ThresholdTable policyId={selected.id} formula={selected.formula} maxLevel={selected.maxLevel} active={selected.active} onChanged={reload} />
              <ImpactPreview policyId={selected.id} active={selected.active} />
              {!selected.active && <ActivateGate policyId={selected.id} version={selected.version} onDone={reload} />}
            </>
          )}

          <SimulatorCard />
        </div>
      )}
    </LevelingLayout>
  );
}

function PolicyDraftForm({ onDone }: { onDone: () => void }) {
  const { client } = useWorkspace();
  const [base, setBase] = useState("100");
  const [exponent, setExponent] = useState("1.5");
  const [maxLevel, setMaxLevel] = useState("100");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const p = await xpAdmin.createPolicy(client, {
        base: Number(base),
        exponent: Number(exponent),
        maxLevel: Number(maxLevel),
      });
      setMsg({ ok: true, text: `Drafted policy v${p.version}. Materialize thresholds before preview.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Draft failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Draft policy version</h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="text-xs">Base<input aria-label="Formula base" className={FIELD} value={base} inputMode="numeric" onChange={(e) => setBase(e.target.value)} /></label>
        <label className="text-xs">Exponent<input aria-label="Formula exponent" className={FIELD} value={exponent} inputMode="decimal" onChange={(e) => setExponent(e.target.value)} /></label>
        <label className="text-xs">Max level<input aria-label="Max level" className={FIELD} value={maxLevel} inputMode="numeric" onChange={(e) => setMaxLevel(e.target.value)} /></label>
      </div>
      <div className="mt-2">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Drafting…" : "Draft version"}
        </MiniButton>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? MUTED : ERROR}`}>{msg.text}</p>}
    </div>
  );
}

function ThresholdTable({
  policyId, formula, maxLevel, active, onChanged,
}: {
  policyId: string; formula: { base: number; exponent: number }; maxLevel: number | null; active: boolean; onChanged: () => void;
}) {
  const { client } = useWorkspace();
  const { data: preview } = useResource(() => xpAdmin.previewPolicy(client, policyId).catch(() => null), [client, policyId]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Show the first 15 levels + the max-level row; full curve lives server-side.
  const rows = (preview?.thresholdDiff ?? []).slice(0, 15);
  const last = preview?.thresholdDiff?.[preview.thresholdDiff.length - 1];

  const materialize = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await xpAdmin.materializePolicy(client, policyId);
      setMsg(`Materialized ${r.thresholdCount} thresholds.`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Materialize failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Thresholds <span className={`text-sm font-normal ${MUTED}`}>floor({formula.base}·L^{formula.exponent}) · max {maxLevel ?? "—"}</span>
        </h2>
        {!active && (
          <MiniButton size="sm" onClick={() => void materialize()} disabled={busy}>
            {busy ? "Materializing…" : "Materialize thresholds"}
          </MiniButton>
        )}
      </div>
      {msg && <p role="status" className={`mt-2 text-sm ${MUTED}`}>{msg}</p>}
      {rows.length === 0 ? (
        <p className={`mt-2 text-sm ${MUTED}`}>
          No materialized thresholds yet — materialize to compute the curve from the formula.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className={`border-b border-border text-left text-xs uppercase tracking-wide ${MUTED}`}>
                <th className="py-2 pr-4">Level</th>
                <th className="py-2 pr-4 text-right">Draft XP</th>
                <th className="py-2 pr-4 text-right">Active XP</th>
                <th className="py-2 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.level} className="border-b border-dotted border-border">
                  <td className="py-1.5 pr-4 font-medium">L{r.level}</td>
                  <td className="py-1.5 pr-4 text-right">{formatXp(r.draftXp)}</td>
                  <td className="py-1.5 pr-4 text-right">{r.activeXp === null ? "—" : formatXp(r.activeXp)}</td>
                  <td className="py-1.5 text-right">{r.delta === null ? "—" : `${r.delta > 0 ? "+" : ""}${formatXp(r.delta)}`}</td>
                </tr>
              ))}
              {last && preview && preview.thresholdDiff.length > 16 && (
                <tr>
                  <td className="py-1.5 pr-4 font-medium">L{last.level}</td>
                  <td className="py-1.5 pr-4 text-right">{formatXp(last.draftXp)}</td>
                  <td className="py-1.5 pr-4 text-right">{last.activeXp === null ? "—" : formatXp(last.activeXp)}</td>
                  <td className="py-1.5 text-right">{last.delta === null ? "—" : `${last.delta > 0 ? "+" : ""}${formatXp(last.delta)}`}</td>
                </tr>
              )}
            </tbody>
          </table>
          {preview && preview.thresholdDiff.length > 16 && (
            <p className={`mt-2 text-xs ${MUTED}`}>Showing 15 of {preview.thresholdDiff.length} levels plus the max-level row.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function ImpactPreview({ policyId, active }: { policyId: string; active: boolean }) {
  const { client } = useWorkspace();
  const { data, loading, error } = useResource(() => xpAdmin.previewPolicy(client, policyId), [client, policyId]);

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Impact preview</h2>
      {loading ? (
        <p role="status" className={`mt-2 text-sm ${MUTED}`}>Computing impact…</p>
      ) : error ? (
        <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{error}</p>
      ) : !data ? (
        <p className={`mt-2 text-sm ${MUTED}`}>Materialize thresholds first — preview needs the draft curve.</p>
      ) : (
        <div className="mt-2 text-sm">
          <p className={MUTED}>
            Draft v{data.version}{data.activeVersion !== null ? ` vs active v${data.activeVersion}` : " (no active policy)"} ·
            evaluated {formatXp(data.userImpact.evaluated)} users{data.userImpact.truncated ? " (truncated at 20k)" : ""}.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <p><span className="font-semibold text-emerald-600 dark:text-emerald-400">+{formatXp(data.userImpact.leveledUp)}</span> <span className={MUTED}>level up</span></p>
            <p><span className="font-semibold text-red-600 dark:text-red-400">−{formatXp(data.userImpact.leveledDown)}</span> <span className={MUTED}>level down</span></p>
            <p><span className="font-semibold">{formatXp(data.userImpact.unchanged)}</span> <span className={MUTED}>unchanged</span></p>
          </div>
          {active && <p className={`mt-2 text-xs ${MUTED}`}>This version is active — no activation needed.</p>}
        </div>
      )}
    </Card>
  );
}

function ActivateGate({ policyId, version, onDone }: { policyId: string; version: number; onDone: () => void }) {
  const { client } = useWorkspace();
  const [confirmedBy, setConfirmedBy] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const verdict = grantEnvelopeStatus({ isRaise: true, confirmedBy, reason });

  const submit = async () => {
    if (!verdict.ok) {
      setMsg({ ok: false, text: verdict.error });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await xpAdmin.activatePolicy(client, policyId, {
        ...(confirmedBy.trim() ? { confirmedBy: confirmedBy.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setMsg({ ok: true, text: `Policy v${version} activated. Levels recompute lazily; migration backfill stays M3-gated.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Activation failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Activation review gate</h2>
      <p className={`mt-1 text-sm ${MUTED}`}>
        Activating v{version} flips the live pointer. A <em>different</em> admin must confirm, or you must
        record a justification (≥ 10 chars). Self-confirm is rejected server-side.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">Second-person confirm (admin PID)
          <input aria-label="Confirming admin PID" className={FIELD} value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} placeholder="peer-admin@pid" />
        </label>
        <label className="text-xs">Justification (or-confirm)
          <input aria-label="Activation justification" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why activate now…" />
        </label>
      </div>
      <div className="mt-3">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Activating…" : `Activate v${version}`}
        </MiniButton>
      </div>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? MUTED : ERROR}`}>{msg.text}</p>}
    </Card>
  );
}

function SimulatorCard() {
  const [base, setBase] = useState("100");
  const [exponent, setExponent] = useState("1.5");
  const [maxLevel, setMaxLevel] = useState("10");
  const [override, setOverride] = useState("");

  let rows: { level: number; cumulativeXp: number }[] = [];
  let simError: string | null = null;
  try {
    const ov = new Map<number, number>();
    for (const line of override.split("\n")) {
      const m = line.trim().match(/^(\d+)\s*[:=]\s*(\d+)$/);
      if (line.trim() && !m) throw new Error(`Bad override line: "${line.trim()}" (use "level: xp")`);
      if (m) ov.set(Number(m[1]), Number(m[2]));
    }
    rows = buildThresholds(Number(maxLevel) || 10, Number(base) || 100, Number(exponent) || 1.5, ov);
  } catch (e) {
    simError = e instanceof Error ? e.message : "Simulator error";
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">Simulator</h2>
      <p className={`mt-1 text-sm ${MUTED}`}>
        Client-side formula preview only — the server materializes and activates. Overrides must keep the
        curve non-decreasing. One per line: <code>level: xp</code>.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="text-xs">Base<input aria-label="Simulator base" className={FIELD} value={base} inputMode="numeric" onChange={(e) => setBase(e.target.value)} /></label>
        <label className="text-xs">Exponent<input aria-label="Simulator exponent" className={FIELD} value={exponent} inputMode="decimal" onChange={(e) => setExponent(e.target.value)} /></label>
        <label className="text-xs">Max level<input aria-label="Simulator max level" className={FIELD} value={maxLevel} inputMode="numeric" onChange={(e) => setMaxLevel(e.target.value)} /></label>
      </div>
      <label className="mt-2 block text-xs">Per-level overrides
        <textarea aria-label="Per-level overrides" className={FIELD} rows={2} value={override} onChange={(e) => setOverride(e.target.value)} placeholder={"25: 120000"} />
      </label>
      {simError ? (
        <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{simError}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[300px] text-sm">
            <thead>
              <tr className={`border-b border-border text-left text-xs uppercase tracking-wide ${MUTED}`}>
                <th className="py-2 pr-4">Level</th>
                <th className="py-2 text-right">Cumulative XP</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 25).map((r) => (
                <tr key={r.level} className="border-b border-dotted border-border">
                  <td className="py-1.5 pr-4 font-medium">L{r.level}</td>
                  <td className="py-1.5 text-right">{formatXp(r.cumulativeXp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 25 && <p className={`mt-2 text-xs ${MUTED}`}>Showing 25 of {rows.length} rows.</p>}
        </div>
      )}
    </Card>
  );
}
