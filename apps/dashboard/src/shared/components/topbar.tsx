import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge, Segmented, SegmentedItem } from "../../shared/ui/kit";

export interface WorkspaceTab {
  key: string;
  label: string;
}

/** Single-row topbar: brand left, tabs middle, network badge + account right. */
export function Topbar({
  tabs,
  active,
  onTab,
  env = "production",
  account,
}: {
  tabs: WorkspaceTab[];
  active: string;
  onTab: (key: string) => void;
  env?: string;
  /** Right slot: the pid account button (ProfileMenu). */
  account?: ReactNode;
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
          title={isSandbox ? "Testnet: test payments — no real money moves here." : "Mainnet: real payments."}
          className="shrink-0"
        >
          {isSandbox ? "testnet" : "mainnet"}
        </Badge>

        <Segmented aria-label="Workspace" className="mx-auto min-w-0">
          {tabs.map((t) => (
            <SegmentedItem key={t.key} active={t.key === active} onClick={() => onTab(t.key)}>
              {t.label}
            </SegmentedItem>
          ))}
        </Segmented>

        {account}
      </div>
    </header>
  );
}
