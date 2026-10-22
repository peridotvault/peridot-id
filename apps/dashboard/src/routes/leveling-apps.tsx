import { useState } from "react";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, WARN, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { MIN_JUSTIFICATION, MVP_EVENT_TYPES, formatXp, grantEnvelopeStatus, validateEventType } from "../leveling/xp";
import { xpAdmin, type XpApp } from "../leveling/api";

/**
 * Applications: verification (verify/revoke), XP permissions (enable/disable,
 * approved events), per-app quotas, contribution views (ledger filtered by
 * app), and suspend-for-abuse. Verification alone grants nothing — intake
 * (M3) requires verified AND xpEnabled AND an approved event type.
 */
export default function LevelingAppsPage() {
  const { client } = useWorkspace();
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const { data, loading, error, reload } = useResource(
    () => xpAdmin.listApps(client, appliedQ || undefined),
    [client, appliedQ],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <LevelingLayout active="apps">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Applications</h2>
            <p className={`mt-1 text-sm ${MUTED}`}>
              Verify partners, gate XP intake per app, and suspend abusive apps. Every change is audited server-side.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs">Search
              <input aria-label="Search apps" className={FIELD} value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or client_id" />
            </label>
            <MiniButton size="sm" variant="solid" onClick={() => setAppliedQ(q.trim())}>Search</MiniButton>
          </div>
        </div>
        {loading ? (
          <p role="status" className={`mt-3 text-sm ${MUTED}`}>Loading apps…</p>
        ) : !data || data.length === 0 ? (
          <p className={`mt-3 text-sm ${MUTED}`}>No apps found.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {data.map((app) => (
              <li key={app.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{app.name}</span>
                    <span className={`ml-2 text-xs ${MUTED}`}>{app.clientId}</span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <Badge on={app.isVerified} label={app.isVerified ? "verified" : "unverified"} />
                    <Badge on={app.xpEnabled} label={app.xpEnabled ? "XP on" : "XP off"} />
                    {!app.isActive && <Badge on={false} label="inactive" />}
                  </span>
                </div>
                <p className={`mt-1 text-xs ${MUTED}`}>
                  owner {app.ownerPid} · events: {app.approvedEventTypes.length > 0 ? app.approvedEventTypes.join(", ") : "none"}
                </p>
                <div className="mt-2">
                  <MiniButton
                    size="xs"
                    onClick={() => setExpanded((cur) => (cur === app.id ? null : app.id))}
                    aria-expanded={expanded === app.id}
                  >
                    {expanded === app.id ? "Hide controls" : "Manage verification / XP"}
                  </MiniButton>
                </div>
                {expanded === app.id && (
                  <AppControls app={app} onChanged={reload} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </LevelingLayout>
  );
}

function Badge({ on, label }: { on: boolean; label: string }) {
  const cls = on
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : "bg-muted text-muted-foreground";
  return <span className={`rounded-[3px] px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

function AppControls({ app, onChanged }: { app: XpApp; onChanged: () => void }) {
  const { client } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [events, setEvents] = useState(app.approvedEventTypes.join(", "));
  const [xpOn, setXpOn] = useState(app.xpEnabled);
  const [confirmedBy, setConfirmedBy] = useState("");
  const [reason, setReason] = useState("");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [monthly, setMonthly] = useState("");
  const [suspendReason, setSuspendReason] = useState("");

  const run = async (label: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : `${label} failed` });
    } finally {
      setBusy(null);
    }
  };

  const parseEvents = (): string[] => {
    const list = events.split(",").map((s) => s.trim()).filter(Boolean);
    const errors = list.map(validateEventType).filter((e): e is string => e !== null);
    if (errors.length > 0) throw new Error(`Event allowlist invalid: ${errors.join("; ")}`);
    if (new Set(list).size !== list.length) throw new Error("Event allowlist has duplicates.");
    if (list.length > 50) throw new Error("Event allowlist too large (max 50).");
    return [...new Set(list)];
  };

  const saveXp = () => {
    const approvedEventTypes = parseEvents();
    const widened = approvedEventTypes.some((t) => !app.approvedEventTypes.includes(t));
    const granting = xpOn && !app.xpEnabled;
    const verdict = grantEnvelopeStatus({ isRaise: granting || (xpOn && widened), confirmedBy, reason });
    if (!verdict.ok) {
      setMsg({ ok: false, text: verdict.error });
      return Promise.resolve();
    }
    return run(
      "xp",
      () =>
        xpAdmin.setXpPermission(client, app.id, {
          xpEnabled: xpOn,
          approvedEventTypes,
          confirmedBy: confirmedBy.trim() || undefined,
          reason: reason.trim() || undefined,
        }).then((r) => {
          if (r.selfGrantAlert) {
            setMsg({ ok: true, text: "Saved. Self-grant flagged: you own this app — a suspicious-activity signal was recorded." });
          }
        }),
      "XP permission saved.",
    );
  };

  const saveQuota = () => {
    const cap = (v: string): number | null | undefined => {
      const t = v.trim();
      if (!t) return undefined;
      if (t === "0") return null;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1) throw new Error("Caps must be positive integers (blank = unchanged, 0 = clear).");
      return n;
    };
    const verdict = grantEnvelopeStatus({ isRaise: true, confirmedBy, reason });
    if (!verdict.ok) {
      setMsg({ ok: false, text: verdict.error });
      return Promise.resolve();
    }
    return run(
      "quota",
      () =>
        xpAdmin.upsertQuota(client, app.id, {
          dailyCap: cap(daily),
          weeklyCap: cap(weekly),
          monthlyCap: cap(monthly),
          confirmedBy: confirmedBy.trim() || undefined,
          reason: reason.trim() || undefined,
        }),
      "Quota saved.",
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
      {/* Verification */}
      <section aria-label="Verification">
        <h3 className="text-sm font-semibold">Verification</h3>
        <p className={`mt-0.5 text-xs ${MUTED}`}>Verified partners only — verification alone grants no XP intake.</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <MiniButton size="xs" variant="solid" disabled={busy !== null} onClick={() => void run("verify", () => xpAdmin.setVerified(client, app.id, true), "App verified.")}>
            {busy === "verify" ? "Saving…" : "Verify"}
          </MiniButton>
          <MiniButton size="xs" disabled={busy !== null} onClick={() => void run("revoke", () => xpAdmin.setVerified(client, app.id, false), "Verification revoked.")}>
            {busy === "revoke" ? "Saving…" : "Revoke"}
          </MiniButton>
        </div>
      </section>

      {/* XP permission */}
      <section aria-label="XP permission">
        <h3 className="text-sm font-semibold">XP permission</h3>
        <p className={`mt-0.5 text-xs ${MUTED}`}>
          Intake (M3) requires verified + XP on + an approved event. Catalog: {MVP_EVENT_TYPES.join(", ")}.
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={xpOn} onChange={(e) => setXpOn(e.target.checked)} aria-label="Enable XP for app" />
            Enable XP
          </label>
        </div>
        <label className="mt-1.5 block text-xs">Approved events (comma-separated)
          <input aria-label="Approved event types" className={FIELD} value={events} onChange={(e) => setEvents(e.target.value)} placeholder="campaign_completed, achievement_earned" />
        </label>
      </section>

      {/* Quotas + envelope */}
      <section aria-label="Quotas">
        <h3 className="text-sm font-semibold">Quotas</h3>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
          <label className="text-xs">Daily<input aria-label="App daily cap" className={FIELD} value={daily} inputMode="numeric" onChange={(e) => setDaily(e.target.value)} placeholder="—" /></label>
          <label className="text-xs">Weekly<input aria-label="App weekly cap" className={FIELD} value={weekly} inputMode="numeric" onChange={(e) => setWeekly(e.target.value)} placeholder="—" /></label>
          <label className="text-xs">Monthly<input aria-label="App monthly cap" className={FIELD} value={monthly} inputMode="numeric" onChange={(e) => setMonthly(e.target.value)} placeholder="—" /></label>
        </div>
        <p className={`mt-1 text-xs ${MUTED}`}>Blank = unchanged, 0 = clear. Current server values are authoritative — shown after save.</p>
      </section>

      <section aria-label="Grant envelope">
        <h3 className="text-sm font-semibold">Grant envelope (F3)</h3>
        <p className={`mt-0.5 text-xs ${MUTED}`}>
          Grants and cap raises need a second-person confirm (a <em>different</em> admin) or a justification ≥ {MIN_JUSTIFICATION} chars.
        </p>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">Confirming admin PID
            <input aria-label="Confirming admin PID" className={FIELD} value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} placeholder="peer-admin@pid" />
          </label>
          <label className="text-xs">Justification
            <input aria-label="Grant justification" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why grant…" />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <MiniButton size="xs" variant="solid" disabled={busy !== null} onClick={() => void saveXp()}>
            {busy === "xp" ? "Saving…" : "Save XP permission"}
          </MiniButton>
          <MiniButton size="xs" disabled={busy !== null} onClick={() => void saveQuota()}>
            {busy === "quota" ? "Saving…" : "Save quota"}
          </MiniButton>
        </div>
      </section>

      {/* Suspend */}
      <section aria-label="Suspend for abuse">
        <h3 className="text-sm font-semibold">Suspend for abuse</h3>
        <p className={`mt-0.5 text-xs ${MUTED}`}>Suspended apps short-circuit awards. A reason is required.</p>
        <label className="mt-1.5 block text-xs">Suspend reason
          <input aria-label="Suspend reason" className={FIELD} value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="Abuse evidence…" />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <MiniButton
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              if (!suspendReason.trim() && !reason.trim()) {
                setMsg({ ok: false, text: "Suspending requires a suspend reason (or envelope justification)." });
                return;
              }
              void run(
                "suspend",
                () => xpAdmin.suspendApp(client, app.id, { suspended: true, suspendReason: suspendReason.trim() || undefined, reason: reason.trim() || undefined }),
                "App suspended — awards short-circuit.",
              );
            }}
          >
            {busy === "suspend" ? "Suspending…" : "Suspend app"}
          </MiniButton>
          <MiniButton
            size="xs"
            disabled={busy !== null}
            onClick={() => void run("unsuspend", () => xpAdmin.suspendApp(client, app.id, { suspended: false, reason: reason.trim() || "Abuse cleared; reinstated." }), "App reinstated.")}
          >
            {busy === "unsuspend" ? "Saving…" : "Reinstate"}
          </MiniButton>
        </div>
      </section>

      <ContributionView appId={app.id} clientId={app.clientId} />

      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? MUTED : msg.text.includes("Self-grant") ? WARN : ERROR}`}>{msg.text}</p>}
    </div>
  );
}

function ContributionView({ appId, clientId }: { appId: string; clientId: string }) {
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const { data, loading } = useResource(
    () => (open ? xpAdmin.ledger(client, { limit: 20 }).then((p) => ({ ...p, rows: p.rows.filter((r) => r.appId === appId) })) : Promise.resolve(null)),
    [client, appId, open],
  );

  return (
    <section aria-label="Contribution view">
      <MiniButton size="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide contributions" : "Show contributions"}
      </MiniButton>
      {open && (
        <div className="mt-2">
          {loading ? (
            <p role="status" className={`text-xs ${MUTED}`}>Loading contributions…</p>
          ) : !data || data.rows.length === 0 ? (
            <p className={`text-xs ${MUTED}`}>No recent ledger entries attributed to {clientId}.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {data.rows.map((r) => (
                <li key={r.id} className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{r.pid} · {r.kind}</span>
                  <span className="shrink-0 font-medium">{r.deltaXp.startsWith("-") ? "" : "+"}{formatXp(r.deltaXp)} XP</span>
                </li>
              ))}
            </ul>
          )}
          <p className={`mt-1 text-xs ${MUTED}`}>Latest ledger entries attributed to this app (client-side filter over recent history).</p>
        </div>
      )}
    </section>
  );
}
