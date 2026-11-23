import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../../shared/ui/page-header";

const TABS = [
  { key: "overview", label: "Overview", to: "/admin/leveling" },
  { key: "levels", label: "Levels", to: "/admin/leveling/levels" },
  { key: "tasks", label: "Tasks", to: "/admin/leveling/tasks" },
  { key: "history", label: "XP History", to: "/admin/leveling/history" },
  { key: "settings", label: "Settings", to: "/admin/leveling/settings" },
  { key: "apps", label: "Applications", to: "/admin/leveling/apps" },
];

/**
 * Leveling section header + sub-navigation. Session and admin gates live in
 * AdminLayout; the server (AdminGuard) enforces.
 */
export function LevelingLayout({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <section>
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
            className={`rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
              t.key === active
                ? "border-foreground bg-foreground text-background"
                : "border-line text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6">{children}</div>
    </section>
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
