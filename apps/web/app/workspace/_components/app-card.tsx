"use client";

import { useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import { Card, DIVIDER, ERROR, FIELD, MUTED, SECTION_LABEL, WARN, MiniButton } from "./ui";

export interface PidApp {
  id: string;
  clientId: string;
  name: string;
  allowedOrigins: string[];
  isActive: boolean;
  clientSecretPrefix: string | null;
  clientSecretCreatedAt: string | null;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <MiniButton
      aria-label={label}
      onClick={() => {
        void copy(text).then((ok) => {
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        });
      }}
      className="font-mono"
    >
      {done ? "Copied" : label}
    </MiniButton>
  );
}

export function AppCard({ client, app, onChanged }: { client: PeridotClient; app: PidApp; onChanged: () => Promise<void> }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(app.name);
  const [newOrigin, setNewOrigin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ secret: string; prefix: string } | null>(null);

  const save = async (patch: { name?: string; allowedOrigins?: string[]; isActive?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      unwrap(await client.patch(`/v1/apps/${app.id}`, patch), "Save");
      setEditingName(false);
      setNewOrigin("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const addOrigin = () => {
    const origin = newOrigin.trim();
    if (!origin) return;
    if (app.allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
      setNewOrigin("");
      return;
    }
    void save({ allowedOrigins: [...app.allowedOrigins, origin] });
  };

  const removeOrigin = (origin: string) => {
    void save({ allowedOrigins: app.allowedOrigins.filter((o) => o !== origin) });
  };

  const rotateSecret = async () => {
    if (!window.confirm("Generate a new backend secret? The current one stops working immediately.")) return;
    setSaving(true);
    setError(null);
    try {
      const { secret, prefix } = unwrap(
        await client.post<{ secret: string; prefix: string }>(`/v1/apps/${app.id}/secret`, {}),
        "Secret rotation",
      );
      setRevealed({ secret, prefix });
      await onChanged();
    } catch {
      setError("Secret rotation failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className={app.isActive ? "" : "opacity-60"}>
      <div className="flex items-center justify-between gap-3">
        {editingName ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className={`${FIELD} font-semibold`}
          />
        ) : (
          <h3 className="font-semibold tracking-tight">
            {app.name} {!app.isActive && <span className={`text-xs font-normal ${MUTED}`}>(disabled)</span>}
          </h3>
        )}
        <div className="flex shrink-0 gap-2">
          <MiniButton
            onClick={() => (editingName ? void save({ name: name.trim() }) : setEditingName(true))}
            disabled={saving}
            className="font-semibold"
          >
            {editingName ? "Save" : "Rename"}
          </MiniButton>
          <MiniButton onClick={() => void save({ isActive: !app.isActive })} disabled={saving}>
            {app.isActive ? "Disable" : "Enable"}
          </MiniButton>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className={MUTED}>client_id</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{app.clientId}</code>
        <CopyButton text={app.clientId} label="Copy" />
      </div>

      <div className={`mt-4 pt-3 ${DIVIDER}`}>
        <p className={SECTION_LABEL}>Allowed origins</p>
        <p className={`mt-1 text-xs ${MUTED}`}>
          Login redirects and API calls are accepted from these websites. Pass the exact
          return URL in code (SDK login or provider redirectUri) — its origin must be listed here.
        </p>
        {app.allowedOrigins.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {app.allowedOrigins.map((o) => (
              <li key={o} className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5">
                <code className="break-all font-mono text-xs">{o}</code>
                <MiniButton
                  aria-label={`Remove ${o}`}
                  onClick={() => removeOrigin(o)}
                  disabled={saving}
                >
                  Delete
                </MiniButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`mt-2 text-xs ${WARN}`}>No origins yet — logins for this app will be rejected until you add one.</p>
        )}
        <div className="mt-2 flex gap-2">
          <input
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addOrigin();
            }}
            placeholder="https://mygame.dev"
            inputMode="url"
            className={`${FIELD} font-mono text-xs`}
          />
          <MiniButton
            variant="solid"
            size="sm"
            onClick={addOrigin}
            disabled={saving || !newOrigin.trim()}
            className="self-end"
          >
            Add
          </MiniButton>
        </div>
      </div>
      {error && <p className={`mt-2 text-xs ${ERROR}`}>{error}</p>}

      <div className={`mt-4 pt-3 ${DIVIDER}`}>
        <p className={SECTION_LABEL}>Backend secret</p>
        {revealed ? (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-black/50">{revealed.secret}</code>
              <CopyButton text={revealed.secret} label="Copy" />
            </div>
          </div>
        ) : (
          <div className={`mt-2 flex items-center gap-2 text-xs ${MUTED}`}>
            {app.clientSecretPrefix ? (
              <span>
                <code className="font-mono">{app.clientSecretPrefix}…</code>
                {app.clientSecretCreatedAt && <> · set {new Date(app.clientSecretCreatedAt).toLocaleDateString()}</>}
              </span>
            ) : (
              <span>No secret — exchange works with client_id alone.</span>
            )}
            <MiniButton onClick={() => void rotateSecret()} disabled={saving} className="font-semibold">
              {app.clientSecretPrefix ? "Rotate" : "Generate"}
            </MiniButton>
          </div>
        )}
      </div>
    </Card>
  );
}
