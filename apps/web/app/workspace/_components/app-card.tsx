"use client";

import { useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";

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
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void copy(text).then((ok) => {
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        });
      }}
      className="rounded-md border border-neutral-300 px-2 py-1 font-mono text-xs hover:bg-neutral-100"
    >
      {done ? "Copied" : label}
    </button>
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
    <article className={`rounded-2xl border p-5 ${app.isActive ? "border-neutral-200" : "border-neutral-200 opacity-60"}`}>
      <div className="flex items-center justify-between gap-3">
        {editingName ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-sm font-semibold"
          />
        ) : (
          <h3 className="font-semibold">
            {app.name} {!app.isActive && <span className="text-xs font-normal text-neutral-500">(disabled)</span>}
          </h3>
        )}
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => (editingName ? void save({ name: name.trim() }) : setEditingName(true))}
            disabled={saving}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-semibold hover:bg-neutral-100 disabled:opacity-60"
          >
            {editingName ? "Save" : "Rename"}
          </button>
          <button
            type="button"
            onClick={() => void save({ isActive: !app.isActive })}
            disabled={saving}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-60"
          >
            {app.isActive ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-neutral-500">client_id</span>
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs">{app.clientId}</code>
        <CopyButton text={app.clientId} label="Copy" />
      </div>

      <div className="mt-4 border-t border-neutral-100 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Allowed origins</p>
        <p className="mt-1 text-xs text-neutral-500">
          Login redirects and API calls are accepted from these websites. Pass the exact
          return URL in code (SDK login or provider redirectUri) — its origin must be listed here.
        </p>
        {app.allowedOrigins.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {app.allowedOrigins.map((o) => (
              <li key={o} className="flex items-center justify-between gap-2 rounded-lg bg-neutral-50 px-3 py-1.5">
                <code className="break-all font-mono text-xs">{o}</code>
                <button
                  type="button"
                  aria-label={`Remove ${o}`}
                  onClick={() => removeOrigin(o)}
                  disabled={saving}
                  className="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-200 disabled:opacity-60"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-amber-700">No origins yet — logins for this app will be rejected until you add one.</p>
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
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={addOrigin}
            disabled={saving || !newOrigin.trim()}
            className="shrink-0 rounded-lg bg-black px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            Add
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-4 border-t border-neutral-100 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Backend secret</p>
        {revealed ? (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold">Copy it now — it will never be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs">{revealed.secret}</code>
              <CopyButton text={revealed.secret} label="Copy" />
            </div>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
            {app.clientSecretPrefix ? (
              <span>
                <code className="font-mono">{app.clientSecretPrefix}…</code>
                {app.clientSecretCreatedAt && <> · set {new Date(app.clientSecretCreatedAt).toLocaleDateString()}</>}
              </span>
            ) : (
              <span>No secret — exchange works with client_id alone.</span>
            )}
            <button
              type="button"
              onClick={() => void rotateSecret()}
              disabled={saving}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-semibold hover:bg-neutral-100 disabled:opacity-60"
            >
              {app.clientSecretPrefix ? "Rotate" : "Generate"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
