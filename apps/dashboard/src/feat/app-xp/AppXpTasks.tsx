import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../workspace/api";
import { Card, ERROR, FIELD, MUTED, SECTION_LABEL, MiniButton } from "../../workspace/ui";

export interface AppXpTask {
  id: string;
  key: string;
  name: string;
  description: string | null;
  xpReward: number;
  status: string;
}

const EMPTY = { key: "", name: "", xpReward: "50" };

/**
 * Self-serve XP tasks: a verified app owner defines which events award XP and
 * how much. Server forces scope/checker/status and rejects unverified apps.
 * XP is cosmetic progression only — never money.
 */
export function AppXpTasks({ client, appId }: { client: PeridotClient; appId: string }) {
  const [rows, setRows] = useState<AppXpTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(unwrap(await client.get<AppXpTask[]>(`/v1/apps/${appId}/xp-tasks`), "Loading XP tasks"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load XP tasks");
    } finally {
      setLoading(false);
    }
  }, [client, appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const xpReward = Number(form.xpReward);
    if (!Number.isInteger(xpReward) || xpReward < 1 || xpReward > 1000) {
      setError("XP must be a whole number 1–1000");
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await client.post<AppXpTask>(`/v1/apps/${appId}/xp-tasks`, {
          key: form.key.trim(),
          name: form.name.trim(),
          xpReward,
        }),
        "Creating XP task",
      );
      setForm(EMPTY);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create XP task");
    } finally {
      setBusy(false);
    }
  }

  async function patch(task: AppXpTask, body: Record<string, unknown>) {
    setBusy(true);
    try {
      unwrap(await client.patch<AppXpTask>(`/v1/apps/${appId}/xp-tasks/${task.id}`, body), "Updating XP task");
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update XP task");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <Card>
        <p className={SECTION_LABEL}>XP tasks</p>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Each task is one event your backend reports. The event key is the event type; XP is added
          to the user&apos;s global PeridotID level. No daily or weekly caps — one award per unique
          event id. Verified apps only.
        </p>
      </Card>

      {error && (
        <Card>
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
        </Card>
      )}

      <Card>
        <p className={SECTION_LABEL}>New task</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_6rem_auto]">
          <label className="text-xs">
            Event key
            <input
              aria-label="Event key"
              className={FIELD}
              placeholder="campaign_completed"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Label
            <input
              aria-label="Task label"
              className={FIELD}
              placeholder="Campaign completed"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="text-xs">
            XP
            <input
              aria-label="XP reward"
              className={FIELD}
              inputMode="numeric"
              value={form.xpReward}
              onChange={(e) => setForm({ ...form, xpReward: e.target.value })}
            />
          </label>
          <div className="flex items-end">
            <MiniButton variant="solid" onClick={() => void create()} disabled={busy || !form.key || !form.name}>
              Add
            </MiniButton>
          </div>
        </div>
      </Card>

      <Card>
        <p className={SECTION_LABEL}>Your tasks</p>
        {loading ? (
          <p role="status" className={`mt-2 text-sm ${MUTED}`}>Loading…</p>
        ) : rows.length === 0 ? (
          <p className={`mt-2 text-sm ${MUTED}`}>No tasks yet. Add the first event your app rewards.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-background p-3 text-sm">
                <span>
                  <span className="font-medium">{t.name}</span>
                  <span className={`ml-2 text-xs ${MUTED}`}>{t.key} · {t.xpReward} XP · {t.status}</span>
                </span>
                <MiniButton
                  size="xs"
                  disabled={busy}
                  onClick={() => void patch(t, { status: t.status === "active" ? "disabled" : "active" })}
                >
                  {t.status === "active" ? "Disable" : "Enable"}
                </MiniButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
