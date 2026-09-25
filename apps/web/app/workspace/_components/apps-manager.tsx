"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { PidApp } from "./app-types";
import { unwrap } from "./api";
import { Card, ERROR, FIELD, MUTED } from "./ui";
import { PageHeader } from "./page-header";
import { CutButton } from "@/components/landing/cut-button";

/** Apps list: name only. Every setting lives on the app's detail page. */
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
      setError("Give the app a name first.");
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
      <PageHeader
        eyebrow="App management"
        title="Apps"
        description="Open an app to manage its origins, backend secret, fees, and balance."
      />
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      {loading ? (
        <p className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {apps.map((app) => (
            <Link
              key={app.id}
              href={`/workspace/apps/${app.id}`}
              className="flex items-center justify-between border border-border bg-background px-4 py-3 transition-colors hover:bg-muted"
            >
              <span className="font-semibold tracking-tight">{app.name}</span>
              <span className={`text-xs ${MUTED}`}>{app.isActive ? "Active" : "Disabled"} →</span>
            </Link>
          ))}
          {apps.length === 0 && <p className={`text-sm ${MUTED}`}>No apps yet — register your first below.</p>}
        </div>
      )}

      <Card className="mt-8">
        <h3 className="font-semibold tracking-tight">Register a new app</h3>
        <p className={`mt-1 text-sm ${MUTED}`}>Just a name — everything else is configured inside the app.</p>
        <label className="mt-3 block text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            placeholder="My Game"
            maxLength={60}
            className={FIELD}
          />
        </label>
        <CutButton
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className={`mt-3 ${creating ? "pointer-events-none opacity-60" : ""}`}
        >
          {creating ? "Registering…" : "Register app"}
        </CutButton>
      </Card>
    </section>
  );
}
