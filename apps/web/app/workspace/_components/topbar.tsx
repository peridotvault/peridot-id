"use client";

export interface WorkspaceTab {
  key: string;
  label: string;
}

/** Single-row topbar: brand, role-gated tabs, session label. No sidebar. */
export function Topbar({
  tabs,
  active,
  onTab,
  sessionLabel,
  isAdmin,
}: {
  tabs: WorkspaceTab[];
  active: string;
  onTab: (key: string) => void;
  sessionLabel: string;
  isAdmin: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-4 px-5 py-3">
        <span className="text-sm font-bold">PeridotID</span>
        <nav className="flex items-center gap-1" aria-label="Workspace">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTab(t.key)}
              aria-current={t.key === active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                t.key === active ? "bg-black text-white" : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="ml-auto truncate text-xs text-neutral-500">
          {isAdmin && (
            <span className="mr-2 rounded-full bg-black px-2 py-0.5 text-[11px] font-semibold text-white">admin</span>
          )}
          {sessionLabel}
        </span>
      </div>
    </header>
  );
}
