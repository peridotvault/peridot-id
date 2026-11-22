"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { PidApp } from "./app-types";
import { unwrap } from "./api";
import { Badge, Card, ERROR, FIELD, MUTED, MiniButton } from "./ui";
import { PageHeader } from "./page-header";

/** Apps list: name only. Every setting lives on the app's detail page. */
export function AppsManager({ client }: { client: PeridotClient }) {
  const [apps, setApps] = useState<PidApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setApps(unwrap(await client.get<PidApp[]>("/v1/apps"), "Loading apps"));
    setError(null);
  }, [client]);

  useEffect(() => {
    load()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load apps"))
      .finally(() => setLoading(false));
  }, [load]);

  // Inline retry next to the error: without this the only recovery is a full
  // page reload (header refresh). Same load path as the initial fetch.
  const retry = useCallback(() => {
    setLoading(true);
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
      {error && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className={`text-sm ${ERROR}`}>{error}</p>
          <MiniButton size="sm" onClick={retry}>
            Retry
          </MiniButton>
        </div>
      )}
      {loading ? (
        <p role="status" className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {apps.map((app) => (
            <Link
              key={app.id}
              to={`/apps/${app.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-line bg-background px-4 py-3 transition-colors hover:bg-muted/40 focus-ring"
            >
              <span className="min-w-0 truncate font-semibold tracking-tight">
                {app.name}
                {app.isVerified && (
                  <Badge tone="success" className="ml-2 align-middle">
                    <span aria-hidden="true">✓</span>
                    <span className="sr-only">Verified</span>
                  </Badge>
                )}
              </span>
              <span className={`shrink-0 text-xs ${MUTED}`}>
                {app.isActive ? "Active" : "Disabled"} <span aria-hidden="true">→</span>
              </span>
            </Link>
          ))}
          {apps.length === 0 && !error && (
            <p className={`text-sm ${MUTED}`}>
              No apps yet — register your first below. New here?{" "}
              <Link to="/demo" className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground">
                Try the sandbox sample
              </Link>
              .
            </p>
          )}
        </div>
      )}

      <Card>
        <h3 className="font-semibold tracking-tight">Register a new app</h3>
        <p className={`mt-1 text-sm ${MUTED}`}>Just a name — everything else is configured inside the app.</p>
        <label className="mt-4 block text-xs">
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
        <MiniButton variant="solid" size="lg"
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className="mt-3"
        >
          {creating ? "Registering…" : "Register app"}
        </MiniButton>
      </Card>
    </section>
  );
}
