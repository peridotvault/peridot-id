import { useState } from "react";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, MiniButton } from "../workspace/ui";
import { LevelingLayout, useResource } from "../leveling/LevelingLayout";
import { RELIABLE_CHECKERS, TASK_RECURRING, TASK_STATUSES } from "../leveling/xp";
import { xpAdmin, type XpTask } from "../leveling/api";

const LIMITS: { key: keyof XpTask; label: string }[] = [
  { key: "lifetimeLimit", label: "Lifetime" },
  { key: "dailyLimit", label: "Daily" },
  { key: "weeklyLimit", label: "Weekly" },
  { key: "monthlyLimit", label: "Monthly" },
];

/** Tasks: CRUD, rewards, limits/cooldowns/availability/scope; activation needs a registered checker (F8). */
export default function LevelingTasksPage() {
  const { client } = useWorkspace();
  const [status, setStatus] = useState("");
  const { data, loading, error, reload } = useResource(
    () => xpAdmin.listTasks(client, { status: status || undefined, limit: 50 }),
    [client, status],
  );
  const [editing, setEditing] = useState<XpTask | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <LevelingLayout active="tasks">
      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={reload}>Retry</MiniButton>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Tasks</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs">Status
              <select aria-label="Filter by status" className={FIELD} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <MiniButton size="sm" variant="solid" onClick={() => { setEditing(null); setCreating(true); }}>
              New task
            </MiniButton>
          </div>
        </div>
        {loading ? (
          <p role="status" className={`mt-2 text-sm ${MUTED}`}>Loading tasks…</p>
        ) : !data || data.rows.length === 0 ? (
          <p className={`mt-2 text-sm ${MUTED}`}>No tasks yet. Create the first reward task to begin.</p>
        ) : (
          <>
            <ul className="mt-3 flex flex-col gap-2">
              {data.rows.map((t) => (
                <li key={t.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{t.name}</span>
                      <span className={`ml-2 text-xs ${MUTED}`}>{t.key} · {t.xpReward} XP · {t.recurring} · {t.status}</span>
                    </span>
                    <MiniButton size="xs" onClick={() => { setCreating(false); setEditing(t); }}>Edit</MiniButton>
                  </div>
                  <p className={`mt-1 text-xs ${MUTED}`}>
                    limits {[t.lifetimeLimit && `life ${t.lifetimeLimit}`, t.dailyLimit && `day ${t.dailyLimit}`, t.weeklyLimit && `wk ${t.weeklyLimit}`, t.monthlyLimit && `mo ${t.monthlyLimit}`].filter(Boolean).join(" · ") || "none"}
                    {t.cooldownSecs ? ` · cooldown ${t.cooldownSecs}s` : ""}
                    {t.scopeAppId ? ` · scoped app ${t.scopeAppId.slice(0, 8)}…` : " · ecosystem-wide"}
                    {" · "}{t.verificationType}{t.verificationChecker ? `/${t.verificationChecker.split(".")[1] ?? t.verificationChecker}` : " (no checker — cannot activate)"}
                  </p>
                </li>
              ))}
            </ul>
            <p className={`mt-2 text-xs ${MUTED}`}>{data.total} total.</p>
          </>
        )}
      </Card>

      {(creating || editing) && (
        <TaskForm
          key={editing?.id ?? "new"}
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={reload}
        />
      )}
    </LevelingLayout>
  );
}

function TaskForm({ initial, onClose, onSaved }: { initial: XpTask | null; onClose: () => void; onSaved: () => void }) {
  const { client } = useWorkspace();
  const [form, setForm] = useState<Record<string, string>>({
    key: initial?.key ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    xpReward: initial ? String(initial.xpReward) : "",
    recurring: initial?.recurring ?? "once",
    lifetimeLimit: initial?.lifetimeLimit?.toString() ?? "",
    dailyLimit: initial?.dailyLimit?.toString() ?? "",
    weeklyLimit: initial?.weeklyLimit?.toString() ?? "",
    monthlyLimit: initial?.monthlyLimit?.toString() ?? "",
    cooldownSecs: initial?.cooldownSecs?.toString() ?? "",
    availableFrom: initial?.availableFrom?.slice(0, 16) ?? "",
    availableUntil: initial?.availableUntil?.slice(0, 16) ?? "",
    verificationType: initial?.verificationType ?? "internal_state",
    verificationChecker: initial?.verificationChecker ?? "",
    scopeAppId: initial?.scopeAppId ?? "",
    status: initial?.status ?? "draft",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const num = (v: string): number | undefined => {
    const t = v.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        xpReward: num(form.xpReward),
        recurring: form.recurring,
        verificationType: form.verificationType,
        status: form.status,
      };
      if (!initial) body.key = form.key.trim();
      for (const k of ["lifetimeLimit", "dailyLimit", "weeklyLimit", "monthlyLimit", "cooldownSecs"]) {
        const v = num(form[k]);
        if (v !== undefined) body[k] = v;
      }
      if (form.availableFrom.trim()) body.availableFrom = new Date(form.availableFrom).toISOString();
      if (form.availableUntil.trim()) body.availableUntil = new Date(form.availableUntil).toISOString();
      else if (initial) body.availableUntil = null;
      if (form.verificationChecker.trim()) body.verificationChecker = form.verificationChecker.trim();
      else if (initial) body.verificationChecker = null;
      if (form.scopeAppId.trim()) body.scopeAppId = form.scopeAppId.trim();
      else if (initial) body.scopeAppId = null;

      if (initial) await xpAdmin.updateTask(client, initial.id, body);
      else await xpAdmin.createTask(client, body);
      onSaved();
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const checkers = RELIABLE_CHECKERS.filter((c) => c.startsWith(`${form.verificationType}.`));

  return (
    <Card>
      <h2 className="text-lg font-semibold tracking-tight">{initial ? "Edit task" : "New task"}</h2>
      {!initial && (
        <label className="mt-2 block text-xs">Key (lowercase, 3–64 chars)
          <input aria-label="Task key" className={FIELD} value={form.key} onChange={(e) => set("key", e.target.value)} placeholder="onboarding_complete" />
        </label>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">Name<input aria-label="Task name" className={FIELD} value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="text-xs">XP reward<input aria-label="XP reward" className={FIELD} value={form.xpReward} inputMode="numeric" onChange={(e) => set("xpReward", e.target.value)} /></label>
        <label className="text-xs">Recurring
          <select aria-label="Recurring" className={FIELD} value={form.recurring} onChange={(e) => set("recurring", e.target.value)}>
            {TASK_RECURRING.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="text-xs">Status
          <select aria-label="Status" className={FIELD} value={form.status} onChange={(e) => set("status", e.target.value)}>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {LIMITS.map((l) => (
          <label key={l.key} className="text-xs">{l.label} limit
            <input aria-label={`${l.label} limit`} className={FIELD} value={form[l.key]} inputMode="numeric" onChange={(e) => set(l.key, e.target.value)} placeholder="—" />
          </label>
        ))}
        <label className="text-xs">Cooldown (secs)
          <input aria-label="Cooldown seconds" className={FIELD} value={form.cooldownSecs} inputMode="numeric" onChange={(e) => set("cooldownSecs", e.target.value)} placeholder="—" />
        </label>
        <label className="text-xs">Available from
          <input aria-label="Available from" type="datetime-local" className={FIELD} value={form.availableFrom} onChange={(e) => set("availableFrom", e.target.value)} />
        </label>
        <label className="text-xs">Available until
          <input aria-label="Available until" type="datetime-local" className={FIELD} value={form.availableUntil} onChange={(e) => set("availableUntil", e.target.value)} />
        </label>
        <label className="text-xs">Verification type
          <select aria-label="Verification type" className={FIELD} value={form.verificationType} onChange={(e) => { set("verificationType", e.target.value); set("verificationChecker", ""); }}>
            <option value="internal_state">internal_state</option>
            <option value="backend_check">backend_check</option>
          </select>
        </label>
        <label className="text-xs">Checker (required to activate)
          <select aria-label="Verification checker" className={FIELD} value={form.verificationChecker} onChange={(e) => set("verificationChecker", e.target.value)}>
            <option value="">— none —</option>
            {checkers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-2 block text-xs">Description
        <input aria-label="Task description" className={FIELD} value={form.description} onChange={(e) => set("description", e.target.value)} />
      </label>
      <label className="mt-2 block text-xs">Scope app ID (blank = ecosystem-wide)
        <input aria-label="Scope app ID" className={FIELD} value={form.scopeAppId} onChange={(e) => set("scopeAppId", e.target.value)} placeholder="—" />
      </label>
      {form.status === "active" && !form.verificationChecker && (
        <p role="note" className="mt-2 text-sm text-amber-700 dark:text-amber-300">
          Activating without a registered checker is refused server-side (400) — pick one above.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Create task"}
        </MiniButton>
        <MiniButton size="sm" onClick={onClose}>Cancel</MiniButton>
      </div>
      {msg && <p role="alert" className={`mt-2 text-sm ${ERROR}`}>{msg}</p>}
    </Card>
  );
}
