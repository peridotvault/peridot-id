import { CutButton } from "./cut-button";

export interface WorkspaceTab {
  key: string;
  label: string;
}

/** Single-row topbar: brand left, tabs middle, session + sign out right. No sidebar. */
export function Topbar({
  tabs,
  active,
  onTab,
  sessionLabel,
  isAdmin,
  env = "production",
  otherWorkspaceUrl,
  onSignOut,
}: {
  tabs: WorkspaceTab[];
  active: string;
  onTab: (key: string) => void;
  sessionLabel: string;
  isAdmin: boolean;
  env?: string;
  otherWorkspaceUrl?: string;
  onSignOut: () => void;
}) {
  const isSandbox = env !== "production";
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4 overflow-x-auto px-5 py-2 sm:px-8">
        <span className="inline-flex shrink-0 items-center justify-self-start">
          <img src="/logo/logo-text.svg" alt="PeridotID" className="h-7 w-auto" />
        </span>
        <nav className="flex shrink-0 items-center gap-1 border border-border bg-muted p-1" aria-label="Workspace">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTab(t.key)}
              aria-current={t.key === active ? "page" : undefined}
              className={`px-3 py-1 text-sm font-medium transition-colors focus-ring ${
                t.key === active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-3 justify-self-end">
          {isSandbox ? (
            <span
              title="Sandbox: DOKU test mode — no real money moves here."
              className="bg-amber-400/20 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
            >
              sandbox
            </span>
          ) : (
            <span
              title="Production: real money via DOKU."
              className="bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
            >
              production
            </span>
          )}
          {/* Sandbox MVP (FR-3 / AC-D1): env switch ALWAYS rendered. The href
              is the configured VITE_OTHER_WORKSPACE_URL or the derived
              counterpart (see lib/config.ts) — never hidden. */}
          <a
            href={otherWorkspaceUrl ?? (isSandbox ? "https://dashboard.peridot.id" : "https://sandbox-dashboard.peridot.id")}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {isSandbox ? "Switch to production" : "Open sandbox"}
          </a>
          <span className="truncate text-xs text-muted-foreground" title={sessionLabel}>
            {isAdmin && (
              <span className="mr-2 bg-brand-1 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-brand-2 dark:text-[#07170f]">
                admin
              </span>
            )}
            {sessionLabel}
          </span>
          <CutButton type="button" variant="outline" onClick={onSignOut}>
            Sign Out
          </CutButton>
        </div>
      </div>
    </header>
  );
}
