"use client";

import { CutButton } from "@/components/landing/cut-button";

export interface WorkspaceTab {
  key: string;
  label: string;
}

const LOGO_CUT =
  "[clip-path:polygon(6px_0,100%_0,100%_calc(100%-6px),calc(100%-6px)_100%,0_100%,0_6px)]";

/** Single-row topbar: brand left, tabs middle, session + wallet link right. No sidebar. */
export function Topbar({
  tabs,
  active,
  onTab,
  sessionLabel,
  isAdmin,
  walletUrl,
}: {
  tabs: WorkspaceTab[];
  active: string;
  onTab: (key: string) => void;
  sessionLabel: string;
  isAdmin: boolean;
  walletUrl: string;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-2 sm:px-8">
        <span className="inline-flex items-center gap-2.5 justify-self-start">
          <span className={`h-6 w-6 bg-foreground ${LOGO_CUT}`} aria-hidden="true" />
          <span className="text-[15px] font-semibold tracking-tight">PeridotID</span>
        </span>
        <nav className="flex items-center gap-1 rounded-md border border-border bg-muted p-1" aria-label="Workspace">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTab(t.key)}
              aria-current={t.key === active ? "page" : undefined}
              className={`rounded-[3px] px-3 py-1 text-sm font-medium transition-colors focus-ring ${
                t.key === active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3 justify-self-end">
          <span className="truncate text-xs text-muted-foreground">
            {isAdmin && (
              <span className="mr-2 rounded-[3px] bg-brand-1 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-brand-2 dark:text-[#07170f]">
                admin
              </span>
            )}
            {sessionLabel}
          </span>
          <CutButton variant="outline" href={walletUrl}>
            Go to wallet
          </CutButton>
        </div>
      </div>
    </header>
  );
}
