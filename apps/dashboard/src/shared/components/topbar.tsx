import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "../../shared/ui/kit";

/** Single-row topbar: brand + "Dashboard" badge left, account menu right.
 *  Navigation lives in the sidebar (per area), so the bar carries none. */
export function Topbar({ account }: { account?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-background/80 backdrop-blur">
      <div className="flex w-full items-center gap-3 px-5 py-2 sm:px-8">
        <Link to="/" aria-label="PeridotID dashboard" className="shrink-0 focus-ring">
          <img src="/logo/logo-text.svg" alt="PeridotID" className="h-7 w-auto" />
        </Link>
        <Badge tone="brand">Dashboard</Badge>
        <div className="ml-auto flex min-w-0 items-center gap-3">{account}</div>
      </div>
    </header>
  );
}
