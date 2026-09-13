"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { AppCard, type PidApp } from "./app-card";
import { unwrap } from "./api";
import { Card, ERROR, FIELD, MUTED, SECTION_TITLE } from "./ui";
import { CutButton } from "@/components/landing/cut-button";

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
      <h2 className={SECTION_TITLE}>Your apps</h2>
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {loading ? (
        <p className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {apps.map((app) => (
            <AppCard key={app.id} client={client} app={app} onChanged={load} />
          ))}
          {apps.length === 0 && <p className={`text-sm ${MUTED}`}>No apps yet — register your first below.</p>}
        </div>
      )}

      <Card className="mt-8">
        <h3 className="font-semibold tracking-tight">Register a new app</h3>
        <p className={`mt-1 text-sm ${MUTED}`}>
          Just a name for now — allowed origins are managed on the app card after.
        </p>
        <label className="mt-3 block text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Game"
            maxLength={60}
            className={FIELD}
          />
        </label>
        <CutButton
          type="button"
          onClick={create}
          disabled={creating}
          className={`mt-3 ${creating ? "pointer-events-none opacity-60" : ""}`}
        >
          {creating ? "Registering…" : "Register app"}
        </CutButton>
      </Card>
    </section>
  );
}
