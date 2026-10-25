/**
 * ANT-460 — admin-only System Settings page (minimal UI per ANT-457 spec §6).
 *
 * Contract: ANT-457 §5 (`GET/PUT /v1/admin/settings/*`, history,
 * effective-intake). The server is authoritative for validation; this page
 * pre-validates per §3 shapes for fast feedback only.
 *
 * States (spec G1–G6, AC F-E1–F-E5): loading / empty / error+retry (edits
 * preserved) / 403 full-page / offline-save (draft kept + retry) / empty
 * filter / backend-unavailable (ANT-459 not yet deployed) / 409 conflict.
 * Layout: desktop table + stacked cards on mobile, banner always on top.
 */
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, FIELD, MUTED, MiniButton, WARN } from "../workspace/ui";
import { PageHeader } from "../workspace/page-header";
import { CutButton } from "../workspace/cut-button";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  coerceSettingValue,
  displaySettingValue,
  formatSettingValue,
  formatUpdatedAt,
  groupForKey,
  lookupKey,
  validateReason,
  validateSettingValue,
  type SettingGroup,
} from "../settings/catalog";
import {
  SettingVersionConflict,
  systemSettings,
  type EffectiveIntake,
  type SettingHistoryEntry,
  type SystemSetting,
} from "../settings/api";

const POLL_MS = 30_000;
const HISTORY_PAGE = 25;

function isAccessDenied(message: string): boolean {
  return /403|forbidden|admin access required/i.test(message);
}

function isBackendMissing(message: string): boolean {
  return /404|not found|failed to fetch|network|load failed/i.test(message);
}

export default function SystemSettingsPage() {
  const { client, status, isAdmin, signIn, busy, error: sessionError } = useWorkspace();

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>
          Checking session…
        </p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Admin" title="System settings" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to continue</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>System settings require a signed-in admin session.</p>
          {sessionError && (
            <p role="alert" className={`mt-3 text-sm ${ERROR}`}>
              {sessionError}
            </p>
          )}
          <div className="mt-4">
            <CutButton type="button" onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : "Sign in with PeridotID"}
            </CutButton>
          </div>
        </Card>
      </main>
    );
  }

  if (!isAdmin) {
    // UX-only gate (F-E4); the server (AdminGuard) enforces.
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Admin" title="System settings" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Admin access required</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            System settings are restricted to admins. Your own level stays visible in the wallet.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <PageHeader
        eyebrow="Admin"
        title="System settings"
        description="Namespaced runtime configuration. Writes require a reason and are audited; the server validates every value."
      />
      <div className="mt-6 flex flex-col gap-4">
        <IntakeBanner client={client} />
        <SettingsSection client={client} />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Effective-intake banner (spec G5): always visible, poll + refocus.  */
/* ------------------------------------------------------------------ */

function IntakeBanner({ client }: { client: PeridotClient }) {
  const [data, setData] = useState<EffectiveIntake | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await systemSettings.effectiveIntake(client);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load intake status");
    }
  }, [client]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  if (error && !data) {
    return (
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>
            Intake status unavailable: {error}
          </p>
          <MiniButton size="sm" onClick={() => void load()}>
            Retry
          </MiniButton>
        </div>
      </Card>
    );
  }

  const open = data?.effectiveIntake === true;
  const degraded = data?.breakdown.source === "defaults-fallback";
  const b = data?.breakdown;

  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`inline-block h-3 w-3 rounded-full ${!data ? "bg-muted" : open && !degraded ? "bg-green-600" : degraded ? "bg-amber-500" : "bg-red-600"}`}
          />
          <h2 className="text-lg font-semibold tracking-tight">
            {!data ? (
              "Loading intake status…"
            ) : degraded ? (
              <span className={WARN}>Config degraded — fail-closed</span>
            ) : open ? (
              "Intake OPEN"
            ) : (
              "Intake CLOSED"
            )}
          </h2>
        </div>
        {error && data && (
          <div className="flex items-center gap-2">
            <p role="alert" className={`text-xs ${ERROR}`}>
              Refresh failed: {error}
            </p>
            <MiniButton size="sm" onClick={() => void load()}>
              Retry
            </MiniButton>
          </div>
        )}
      </div>
      {b && (
        <dl className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Intake breakdown">
          <Chip label={`global suspend ${onOff(b.suspendGlobal)}`} on={!b.suspendGlobal} invert />
          <Chip label={`app suspend ${onOff(b.suspendApp)}`} on={!b.suspendApp} invert />
          <Chip label={`source ${b.source}`} on={b.source === "db"} />
        </dl>
      )}
      <p className={`mt-2 text-xs ${MUTED}`}>
        effectiveIntake = NOT global suspend AND NOT app suspend. Any unreadable input denies awarding
        (fail-closed). Refreshes every 30s and on focus.
      </p>
    </Card>
  );
}

function onOff(v: boolean): string {
  return v ? "on" : "off";
}

function Chip({ label, on, invert = false }: { label: string; on: boolean; invert?: boolean }) {
  const good = invert ? on : on;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-medium ${good ? "border-border text-muted-foreground" : "border-red-300 text-red-600 dark:border-red-800 dark:text-red-400"}`}
    >
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Settings list: search + prefix chips + grouped rows (spec G1).      */
/* ------------------------------------------------------------------ */

function SettingsSection({ client }: { client: PeridotClient }) {
  const [settings, setSettings] = useState<SystemSetting[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<SettingGroup | "all">("all");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await systemSettings.list(client, "xp.");
      setSettings(res.settings);
      setError(null);
    } catch (e) {
      // Keep stale rows + open editors: do NOT clear settings (edit-preserving retry, F-E5).
      setError(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyUpdate = useCallback((updated: SystemSetting) => {
    setSettings((prev) => (prev ? prev.map((s) => (s.key === updated.key ? updated : s)) : prev));
  }, []);

  if (loading && settings === null) {
    return (
      <Card>
        <p role="status" className={`text-sm ${MUTED}`}>
          Loading system settings…
        </p>
      </Card>
    );
  }

  if (error && settings === null) {
    if (isAccessDenied(error)) {
      // Role changed mid-session or guard rejected: full-page 403 (F-E4).
      return (
        <Card>
          <h2 className="text-lg font-semibold tracking-tight">Admin access required</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>{error}</p>
        </Card>
      );
    }
    return (
      <Card>
        <h2 className="text-lg font-semibold tracking-tight">
          {isBackendMissing(error) ? "Settings API unavailable" : "Could not load settings"}
        </h2>
        <p className={`mt-1 text-sm ${MUTED}`}>
          {isBackendMissing(error)
            ? "The admin settings backend (ANT-459) is not reachable yet — no values were changed. Retry once the backend is deployed."
            : error}
        </p>
        <div className="mt-3">
          <MiniButton size="sm" onClick={() => void load()}>
            Retry
          </MiniButton>
        </div>
      </Card>
    );
  }

  const rows = settings ?? [];
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((s) => {
    if (group !== "all" && groupForKey(s.key) !== group) return false;
    if (q && !s.key.toLowerCase().includes(q)) return false;
    return true;
  });
  const groupsPresent = GROUP_ORDER.filter((g) => rows.some((s) => groupForKey(s.key) === g));

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Keys ({filtered.length})</h2>
          <label className="text-xs sm:max-w-xs sm:flex-1">
            <span className="sr-only">Filter keys by substring</span>
            <input
              className={FIELD}
              placeholder="Filter keys…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by group">
          <FilterChip active={group === "all"} onClick={() => setGroup("all")} label="All" />
          {GROUP_ORDER.map((g) => (
            <FilterChip
              key={g}
              active={group === g}
              onClick={() => setGroup(group === g ? "all" : g)}
              label={GROUP_LABELS[g]}
            />
          ))}
        </div>
        {error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className={`text-sm ${ERROR}`}>
              Refresh failed: {error} (showing last loaded values)
            </p>
            <MiniButton size="sm" onClick={() => void load()}>
              Retry
            </MiniButton>
          </div>
        )}
        {rows.length === 0 ? (
          <p className={`text-sm ${MUTED}`}>No settings found. Seed the catalog from the backend first.</p>
        ) : filtered.length === 0 ? (
          <p className={`text-sm ${MUTED}`}>
            No keys match{q ? ` “${query.trim()}”` : ""}
            {group !== "all" ? ` in ${GROUP_LABELS[group]}` : ""}. Clear the filter to see all keys.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {GROUP_ORDER.filter((g) => groupsPresent.includes(g)).map((g) => {
              const inGroup = filtered.filter((s) => groupForKey(s.key) === g);
              if (inGroup.length === 0) return null;
              return (
                <section key={g} aria-label={GROUP_LABELS[g]}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {GROUP_LABELS[g]}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {inGroup.map((s) => (
                      <li
                        key={s.key}
                        className="rounded-lg border border-border p-3 sm:p-4"
                      >
                        <SettingRow
                          setting={s}
                          editing={editingKey === s.key}
                          showingHistory={historyKey === s.key}
                          onEdit={() => {
                            setEditingKey(s.key);
                            setHistoryKey(null);
                          }}
                          onCloseEdit={() => setEditingKey(null)}
                          onToggleHistory={() => {
                            setHistoryKey(historyKey === s.key ? null : s.key);
                            setEditingKey(null);
                          }}
                          onSaved={(u) => {
                            applyUpdate(u);
                            setEditingKey(null);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-ring ${
        active ? "border-foreground bg-foreground text-background" : "border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Row: read view + typed edit form + history (spec G2–G4).            */
/* ------------------------------------------------------------------ */

function SettingRow({
  setting,
  editing,
  showingHistory,
  onEdit,
  onCloseEdit,
  onToggleHistory,
  onSaved,
}: {
  setting: SystemSetting;
  editing: boolean;
  showingHistory: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  onToggleHistory: () => void;
  onSaved: (u: SystemSetting) => void;
}) {
  const { client } = useWorkspace();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <code className="break-all text-sm font-semibold">{setting.key}</code>
        <span className={`shrink-0 text-xs ${MUTED}`}>
          v{setting.version} · {setting.updatedBy} · {formatUpdatedAt(setting.updatedAt)}
        </span>
      </div>
      <p className="break-all font-mono text-sm">{displaySettingValue(setting.value, setting.valueType)}</p>
      <div className="flex flex-wrap gap-2">
        {!editing ? (
          <MiniButton size="sm" onClick={onEdit}>
            Edit
          </MiniButton>
        ) : (
          <MiniButton size="sm" onClick={onCloseEdit}>
            Cancel
          </MiniButton>
        )}
        <MiniButton size="sm" onClick={onToggleHistory} aria-expanded={showingHistory}>
          {showingHistory ? "Hide history" : "History"}
        </MiniButton>
      </div>
      {editing && <EditForm key={setting.key + setting.version} setting={setting} client={client} onSaved={onSaved} onCancel={onCloseEdit} />}
      {showingHistory && <HistoryView key={`h-${setting.key}`} settingKey={setting.key} client={client} />}
    </div>
  );
}

function inputForType(valueType: string): "toggle" | "number" | "text" | "json" {
  if (valueType === "boolean") return "toggle";
  if (valueType === "integer" || valueType === "number") return "number";
  if (valueType === "json") return "json";
  return "text";
}

function EditForm({
  setting,
  client,
  onSaved,
  onCancel,
}: {
  setting: SystemSetting;
  client: PeridotClient;
  onSaved: (u: SystemSetting) => void;
  onCancel: () => void;
}) {
  const kind = inputForType(setting.valueType);
  const [draft, setDraft] = useState(() => formatSettingValue(setting.value, setting.valueType));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SystemSetting | null>(null);

  const valueError = validateSettingValue(setting.key, kind === "toggle" ? draft : draft);
  const reasonError = validateReason(reason);
  // Reason-required writes (F-E2): save stays disabled until both pass.
  const canSave = !busy && valueError === null && reasonError === null;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      const value = coerceSettingValue(setting.key, draft);
      const updated = await systemSettings.put(client, setting.key, {
        value,
        reason: reason.trim(),
        expectedVersion: setting.version,
      });
      onSaved(updated);
    } catch (e) {
      // Draft + reason are local state: preserved across failure (F-E5).
      if (e instanceof SettingVersionConflict) {
        setConflict(e.current);
      } else {
        setSaveError(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      setBusy(false);
    }
  };

  if (conflict) {
    // 409: never silent-overwrite (F-E3) — show actor/time/current + Reload.
    return (
      <div role="alert" className="rounded-lg border border-amber-500/50 p-3">
        <p className="text-sm font-semibold">Changed by someone else — not overwritten</p>
        <p className={`mt-1 text-sm ${MUTED}`}>
          Changed by {conflict.updatedBy} at {formatUpdatedAt(conflict.updatedAt)} (now v{conflict.version}).
          Your draft is preserved below.
        </p>
        <p className="mt-2 break-all font-mono text-sm">
          Current: {displaySettingValue(conflict.value, conflict.valueType)}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <MiniButton
            size="sm"
            variant="solid"
            onClick={() => {
              onSaved(conflict);
              setConflict(null);
            }}
          >
            Reload current value
          </MiniButton>
          <MiniButton size="sm" onClick={() => setConflict(null)}>
            Keep editing my draft
          </MiniButton>
        </div>
      </div>
    );
  }

  const entry = lookupKey(setting.key);
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-dotted border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {entry && (
        <p className={`text-xs ${MUTED}`}>
          {entry.description} Type: {setting.valueType}.
        </p>
      )}
      {kind === "toggle" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft === "true"}
            onChange={(e) => setDraft(e.target.checked ? "true" : "false")}
            aria-label={`Value for ${setting.key}`}
          />
          {draft === "true" ? "true" : "false"}
        </label>
      ) : kind === "json" ? (
        <label className="block text-xs">
          Value (JSON)
          <textarea
            className={`${FIELD} font-mono`}
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Value for ${setting.key}`}
            spellCheck={false}
          />
        </label>
      ) : kind === "number" ? (
        <label className="block text-xs">
          Value
          <input
            className={FIELD}
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Value for ${setting.key}`}
          />
        </label>
      ) : (
        <label className="block text-xs">
          Value
          <input
            className={FIELD}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Value for ${setting.key}`}
          />
        </label>
      )}
      {valueError && (
        <p role="alert" className={`text-xs ${ERROR}`}>
          {valueError}
        </p>
      )}
      <label className="block text-xs">
        Reason for change ({reason.trim().length}/{MAX_REASON_LENGTH}, min {MIN_REASON_LENGTH})
        <input
          className={FIELD}
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this change needed? (required, audited)"
          aria-label={`Reason for changing ${setting.key}`}
        />
      </label>
      {reason.trim().length > 0 && reasonError && (
        <p role="alert" className={`text-xs ${ERROR}`}>
          {reasonError}
        </p>
      )}
      {saveError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-xs ${ERROR}`}>
            Save failed: {saveError} — your draft is preserved.
          </p>
          <MiniButton size="sm" onClick={() => void submit()}>
            Retry
          </MiniButton>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <MiniButton size="sm" variant="solid" onClick={() => void submit()} disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </MiniButton>
        <MiniButton size="sm" onClick={onCancel}>
          Cancel
        </MiniButton>
      </div>
      {!canSave && !busy && (
        <p className={`text-xs ${MUTED}`}>
          Save is disabled until the value is valid and a {MIN_REASON_LENGTH}–{MAX_REASON_LENGTH} character
          reason is entered.
        </p>
      )}
    </form>
  );
}

function HistoryView({ settingKey, client }: { settingKey: string; client: PeridotClient }) {
  const [entries, setEntries] = useState<SettingHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (c: string | undefined, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await systemSettings.history(client, settingKey, { limit: HISTORY_PAGE, cursor: c });
        setEntries((prev) => (append ? [...prev, ...res.entries] : res.entries));
        setCursor(res.nextCursor);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load history");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [client, settingKey],
  );

  useEffect(() => {
    void loadPage(undefined, false);
  }, [loadPage]);

  if (loading) {
    return (
      <p role="status" className={`text-xs ${MUTED}`}>
        Loading history…
      </p>
    );
  }
  if (error && entries.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className={`text-xs ${ERROR}`}>
          History unavailable: {error}
        </p>
        <MiniButton size="sm" onClick={() => void loadPage(undefined, false)}>
          Retry
        </MiniButton>
      </div>
    );
  }
  if (entries.length === 0) {
    return <p className={`text-xs ${MUTED}`}>No changes recorded for this key yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {entries.map((h) => (
          <li key={h.version} className="rounded border border-border p-2 text-xs">
            <p className="font-semibold">
              v{h.version} · {h.updatedBy} · {formatUpdatedAt(h.updatedAt)}
            </p>
            <p className="mt-1 break-all font-mono">
              {short(h.oldValue)} → {short(h.newValue)}
            </p>
            <p className={`mt-1 ${MUTED}`}>Reason: {h.reason}</p>
          </li>
        ))}
      </ol>
      {cursor && (
        <div>
          <MiniButton size="sm" onClick={() => void loadPage(cursor, true)} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </MiniButton>
        </div>
      )}
    </div>
  );
}

function short(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return "—";
  }
}
