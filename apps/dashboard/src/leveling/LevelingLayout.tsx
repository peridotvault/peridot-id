import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED } from "../workspace/ui";
import { PageHeader } from "../workspace/page-header";
import { CutButton } from "../workspace/cut-button";

const TABS = [
  { key: "overview", label: "Overview", to: "/leveling" },
  { key: "levels", label: "Levels", to: "/leveling/levels" },
  { key: "tasks", label: "Tasks", to: "/leveling/tasks" },
  { key: "history", label: "XP History", to: "/leveling/history" },
  { key: "settings", label: "Settings", to: "/leveling/settings" },
  { key: "apps", label: "Applications", to: "/leveling/apps" },
];

/**
 * Shared leveling shell: session gate + Role.admin gate + sub-navigation.
 * Non-admin developers get no system-wide leveling admin (plan §7): the tab
 * is admin-only and direct URLs render an access notice. The server
 * (AdminGuard) enforces — this gate is UX only.
 */
export function LevelingLayout({ active, children }: { active: string; children: React.ReactNode }) {
  const { status, isAdmin, signIn, busy, error } = useWorkspace();

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Leveling" title="Leveling admin" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to continue</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>Leveling administration requires a signed-in admin session.</p>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
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
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Leveling" title="Leveling admin" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Admins only</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Leveling configuration and XP adjustments require the admin role. Developers get no
            system-wide leveling admin; your own level stays visible in the wallet.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <PageHeader
        eyebrow="Leveling"
        title="Leveling admin"
        description="Progression, tasks, XP history, and per-app verification / XP permissions."
      />
      <nav aria-label="Leveling sections" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.to}
            aria-current={t.key === active ? "page" : undefined}
            className={`rounded-[3px] border px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
              t.key === active
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6">{children}</div>
    </main>
  );
}

/** Minimal async-resource hook: loading / error / empty handled by callers. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const fn = useRef(load);
  fn.current = load;

  useEffect(() => {
    let live = true;
    setLoading(true);
    fn
      .current()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
