"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "./api";
import type { PidApp } from "./app-types";
import { Card, ERROR, FIELD, MUTED, MiniButton } from "./ui";
import { PageHeader } from "./page-header";

type AdminApp = PidApp & { ownerPid: string };

/** Admin partner directory: every registered app with verify/unverify inline.
 *  Verified partners skip the PeridotID fiat fee (their own app fee, DOKU,
 *  and on-chain fees still apply). */
export function PartnersManager({ client }: { client: PeridotClient }) {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const suffix = q ? `?q=${encodeURIComponent(q)}` : "";
        setApps(unwrap(await client.get<AdminApp[]>(`/v1/admin/apps${suffix}`), "Loading apps"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load apps");
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // Search never fetches per letter: typing only restarts the 2s timer, and
  // the API is hit once the user pauses. Clearing the box restores the full
  // list immediately.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      void load("");
      return;
    }
    const t = setTimeout(() => {
      void load(q);
    }, 2000);
    return () => clearTimeout(t);
  }, [query, load]);

  const flip = async (app: AdminApp) => {
    setBusyId(app.id);
    setError(null);
    try {
      const updated = unwrap(
        await client.patch<AdminApp>(`/v1/admin/apps/${app.id}/verify`, { verified: !app.isVerified }),
        "Update",
      );
      setApps((prev) => prev.map((a) => (a.id === app.id ? updated : a)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mt-8">
      <PageHeader
        eyebrow="Partnerships"
        title="Partners"
        description="Every registered app. Verified partners skip the PeridotID fiat fee — users see a ✓ badge at login."
      />
      {error && <p className={`mt-2 text-sm ${ERROR}`}>{error}</p>}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by app name or client_id…"
        aria-label="Search apps"
        className={`mt-4 max-w-md ${FIELD}`}
      />
      {loading ? (
        <p className={`mt-4 text-sm ${MUTED}`}>Loading…</p>
      ) : apps.length === 0 ? (
        <p className={`mt-4 text-sm ${MUTED}`}>
          {query.trim() ? `No apps match "${query.trim()}".` : "No apps registered yet."}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {apps.map((app) => (
            <Card key={app.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold tracking-tight">
                  {app.name}{" "}
                  {app.isVerified && (
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      ✓ Verified — 0% PeridotID fee
                    </span>
                  )}
                </p>
                <p className={`mt-0.5 truncate font-mono text-xs ${MUTED}`}>{app.clientId}</p>
                <p className={`mt-0.5 text-xs ${MUTED}`}>
                  owner {app.ownerPid} · {app.isActive ? "active" : "disabled"}
                </p>
              </div>
              <MiniButton onClick={() => void flip(app)} disabled={busyId !== null} className="shrink-0">
                {busyId === app.id ? "…" : app.isVerified ? "Unverify" : "Verify"}
              </MiniButton>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
