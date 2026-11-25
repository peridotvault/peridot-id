"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { PidApp } from "../../shared/app-types";
import { unwrap } from "../../shared/api";
import { Badge, Card, ERROR, FIELD, MUTED, MiniButton, Segmented, SegmentedItem } from "../../shared/ui/kit";
import { PageHeader } from "../../shared/ui/page-header";
import type { DashboardMode } from "../../shared/lib/config";

type Clients = Record<DashboardMode, PeridotClient>;

/** One list across both networks; each row carries its environment badge. */
interface Row {
  env: DashboardMode;
  app: PidApp;
}

/**
 * Apps list: name + environment. Every setting lives on the app's detail page,
 * which is scoped to the app's own network (`/apps/:env/:id`) — a testnet app
 * never shows mainnet numbers.
 */
export function AppsManager({ clients, mode }: { clients: Clients; mode: DashboardMode }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [createEnv, setCreateEnv] = useState<DashboardMode>(mode);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const envs: DashboardMode[] = ["mainnet", "testnet"];
    const results = await Promise.allSettled(
      envs.map(async (env): Promise<Row[]> => {
        const apps = unwrap(await clients[env].get<PidApp[]>("/v1/apps"), "Loading apps");
        return apps.map((app) => ({ env, app }));
      }),
    );
    const loaded = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    // One API can back both clients (local dev, no VITE_TEST_API_URL): list
    // each app once instead of twice. Real networks have distinct app ids.
    const unique = loaded.filter((row, i) => loaded.findIndex((x) => x.app.id === row.app.id) === i);
    // Sort by network then name so the badges do not interleave.
    setRows(unique.sort((a, b) => a.env.localeCompare(b.env) || a.app.name.localeCompare(b.app.name)));
    const failures = results.filter((r) => r.status === "rejected").length;
    setError(failures === 0 ? null : `Couldn't load ${failures === 2 ? "either environment" : "one environment"} — showing what's available.`);
  }, [clients]);

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
      unwrap(await clients[createEnv].post<PidApp>("/v1/apps", { name: name.trim() }), "App registration");
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "App registration failed");
    } finally {
      setCreating(false);
    }
  }, [clients, createEnv, name, load]);

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="App management"
        title="Apps"
        description="Mainnet and testnet apps in one list. Open an app to manage its origins, backend secret, fees, and balance."
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
          {rows.map(({ env, app }) => (
            <Link
              key={`${env}:${app.id}`}
              to={`/apps/${env}/${app.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-line bg-background px-4 py-3 transition-colors hover:bg-muted/40 focus-ring"
            >
              <span className="min-w-0 truncate font-semibold tracking-tight">
                {app.name}
                <Badge tone={env === "testnet" ? "warning" : "success"} className="ml-2 align-middle">
                  {env}
                </Badge>
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
          {rows.length === 0 && !error && (
            <p className={`text-sm ${MUTED}`}>
              No apps yet — register your first below. New here?{" "}
              <Link to="/demo" className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground">
                Try the testnet sample
              </Link>
              .
            </p>
          )}
        </div>
      )}

      <Card>
        <h3 className="font-semibold tracking-tight">Register a new app</h3>
        <p className={`mt-1 text-sm ${MUTED}`}>
          Just a name and a network — everything else is configured inside the app. Testnet apps are separate
          registrations with test money; mainnet apps move real money.
        </p>
        <div className="mt-4">
          <Segmented aria-label="Environment">
            <SegmentedItem active={createEnv === "mainnet"} onClick={() => setCreateEnv("mainnet")}>
              Mainnet
            </SegmentedItem>
            <SegmentedItem active={createEnv === "testnet"} onClick={() => setCreateEnv("testnet")}>
              Testnet
            </SegmentedItem>
          </Segmented>
        </div>
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
          {creating ? "Registering…" : `Register ${createEnv} app`}
        </MiniButton>
      </Card>
    </section>
  );
}
