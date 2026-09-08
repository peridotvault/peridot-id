"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { AppCard, type PidApp } from "./app-card";
import { unwrap } from "./api";

export function AppsManager({ client }: { client: PeridotClient }) {
  const [apps, setApps] = useState<PidApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setApps(unwrap(await client.get<PidApp[]>("/v1/apps"), "Loading apps"));
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load apps"))
      .finally(() => setLoading(false));
  }, [load]);

  const create = useCallback(async () => {
    if (!name.trim()) {
      setError("Give the app a name first — allowed origins are managed after.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      unwrap(await client.post<PidApp>("/v1/apps", { name: name.trim() }), "App registration");
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "App registration failed");
    } finally {
      setCreating(false);
    }
  }, [client, name, load]);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Your apps</h2>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="mt-4 text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {apps.map((app) => (
            <AppCard key={app.id} client={client} app={app} onChanged={load} />
          ))}
          {apps.length === 0 && <p className="text-sm text-neutral-500">No apps yet — register your first below.</p>}
        </div>
      )}

      <div className="mt-8 rounded-2xl border border-neutral-200 p-6">
        <h3 className="font-semibold">Register a new app</h3>
        <p className="mt-1 text-sm text-neutral-500">
          Just a name for now — allowed origins are managed on the app card after.
        </p>
        <label className="mt-3 block text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Game"
            maxLength={60}
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={create}
          disabled={creating}
          className="mt-3 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {creating ? "Registering…" : "Register app"}
        </button>
      </div>
    </section>
  );
}
