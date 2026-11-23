import { Link } from "react-router";
import { Badge, MiniButton, Segmented, SegmentedItem } from "../../shared/ui/kit";

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
    <header className="sticky top-0 z-10 border-b border-line bg-background/80 backdrop-blur">
      <div className="flex w-full items-center gap-4 px-5 py-2 sm:px-8">
        <Link to="/" aria-label="PeridotID workspace" className="shrink-0 focus-ring">
          <img src="/logo/logo-text.svg" alt="PeridotID" className="h-7 w-auto" />
        </Link>
        <Badge
          tone={isSandbox ? "warning" : "success"}
          title={isSandbox ? "Sandbox: test payments — no real money moves here." : "Production: real payments."}
          className="shrink-0"
        >
          {isSandbox ? "sandbox" : "production"}
        </Badge>

        <Segmented aria-label="Workspace" className="mx-auto min-w-0">
          {tabs.map((t) => (
            <SegmentedItem key={t.key} active={t.key === active} onClick={() => onTab(t.key)}>
              {t.label}
            </SegmentedItem>
          ))}
        </Segmented>

        <div className="flex min-w-0 shrink-0 items-center gap-3">
          {/* Sandbox MVP (FR-3 / AC-D1): env switch ALWAYS rendered. The href
              is the configured VITE_OTHER_WORKSPACE_URL or the derived
              counterpart (see lib/config.ts) — never hidden. */}
          <a
            href={otherWorkspaceUrl ?? (isSandbox ? "https://dashboard.peridot.id" : "https://sandbox-dashboard.peridot.id")}
            className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
          >
            {isSandbox ? "Switch to production" : "Open sandbox"}
          </a>
          <span className="hidden min-w-0 items-center gap-2 text-xs text-muted-foreground md:flex">
            {isAdmin && <Badge tone="brand">admin</Badge>}
            <span className="max-w-48 truncate" title={sessionLabel}>
              {sessionLabel}
            </span>
          </span>
          <MiniButton variant="outline" size="md" onClick={onSignOut}>
            Sign Out
          </MiniButton>
        </div>
      </div>
    </header>
  );
}
