import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { PageErrorBoundary } from "./error-boundary";

export interface RailItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Group heading rendered above this row (first row of a group). */
  group?: string;
  /** Force the active look for query-string nav (undefined = NavLink matching). */
  active?: boolean;
}

/** Nav/footer row (peridotbase rail): icon + label, 40px tall, 8px corners. */
export const RAIL_TILE =
  "relative flex h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-ring";

/**
 * Shared console shell — one boilerplate for the workspace and /admin: sticky
 * rail (nav + footer actions) on the left, one content column on the right.
 * With no nav the rail is omitted (a single-page area needs no sidebar). Brand
 * and env badge live in the topbar. Pages only own their body; padding and
 * width live here.
 */
export function Shell({
  nav = [],
  footer,
  children,
}: {
  nav?: RailItem[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Section swaps change the query string; keying the boundary by it means a
  // crashed page recovers on the next click instead of staying broken.
  const { pathname, search } = useLocation();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {nav.length > 0 && (
        <aside className="flex shrink-0 items-center gap-2 border-b border-line bg-background px-3 py-2 md:sticky md:top-[var(--topbar-h)] md:h-[calc(100dvh-var(--topbar-h))] md:w-56 md:flex-col md:items-stretch md:gap-1 md:border-b-0 md:border-r md:px-3 md:py-4">
          <nav
            aria-label="Sections"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto md:w-full md:flex-none md:flex-col md:gap-0.5 md:overflow-visible"
          >
            {nav.map(({ to, label, icon: Icon, group, active }) => {
              const body = (
                <>
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="whitespace-nowrap">{label}</span>
                </>
              );
              return (
                <div key={to} className="flex shrink-0 flex-col md:w-full md:shrink">
                  {group && (
                    <p className="hidden px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground md:block">{group}</p>
                  )}
                  {active === undefined ? (
                    <NavLink
                      to={to}
                      className={({ isActive }) => cn(RAIL_TILE, "md:w-full", isActive && "bg-muted text-foreground")}
                    >
                      {body}
                    </NavLink>
                  ) : (
                    <Link to={to} className={cn(RAIL_TILE, "md:w-full", active && "bg-muted text-foreground")}>
                      {body}
                    </Link>
                  )}
                </div>
              );
            })}
          </nav>

          {footer && (
            <div className="ml-auto flex items-center gap-1 md:ml-0 md:mt-auto md:w-full md:flex-col md:gap-0.5 md:border-t md:border-line md:pt-2">
              {footer}
            </div>
          )}
        </aside>
      )}

      <main id="main-content" className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-8 sm:px-8">
          <PageErrorBoundary key={`${pathname}${search}`}>{children}</PageErrorBoundary>
        </div>
      </main>
    </div>
  );
}
