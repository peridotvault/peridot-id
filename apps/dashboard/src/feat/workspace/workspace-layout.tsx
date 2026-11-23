import { Link, Outlet, useMatch, useSearchParams } from "react-router";
import { AppWindow, ArrowLeft, FlaskConical, KeyRound, LayoutDashboard, LogOut, Plug, Receipt, Settings, ShieldCheck, Trophy, Users } from "lucide-react";
import { Card, ERROR, MiniButton, MUTED } from "../../shared/ui/kit";
import { PageHeader } from "../../shared/ui/page-header";
import { RAIL_TILE, Shell, type RailItem } from "../../shared/components/shell";
import { useWorkspace } from "../../shared/components/workspace-provider";
import { APP_SECTIONS } from "../../shared/app-types";
import { cn } from "../../shared/lib/cn";

/**
 * Developer workspace shell: the same rail as /admin (topbar stays global),
 * so the two consoles feel like one product. Session gates live here; child
 * routes can assume an owner session.
 */
/** Rail icons per app section (kept out of app-types so it stays icon-free). */
const SECTION_ICON = {
  overview: LayoutDashboard,
  users: Users,
  general: Settings,
  keys: KeyRound,
  fees: Receipt,
  integrations: Plug,
  xp: Trophy,
};

export function WorkspaceLayout() {
  const { status, isAdmin, env, mode, setMode, pid, busy, error, signIn, signOut } = useWorkspace();
  const appMatch = useMatch("/apps/:env/:id/*") ?? useMatch("/apps/:env/:id");
  const [params] = useSearchParams();
  const appId = appMatch?.params.id;
  const appEnv = appMatch?.params.env === "testnet" ? "testnet" : "mainnet";
  const section = params.get("section") ?? "overview";

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
        <PageHeader
          eyebrow="PeridotID for developers"
          title="Workspace"
          description="Register client_ids, edit allowed origins, and generate backend secrets."
        />
        <Card>
          <h2 className="text-base font-semibold tracking-tight">Sign in to manage your apps</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>This area requires a PeridotID identity.</p>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-4">
            <MiniButton variant="solid" size="lg" type="button" onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : "Sign in with PeridotID"}
            </MiniButton>
          </div>
        </Card>
      </main>
    );
  }

  // Inside one app the rail becomes that app's sections — one sidebar, never two.
  const nav: RailItem[] = appId
    ? [
        { to: "/", label: "All apps", icon: ArrowLeft },
        ...APP_SECTIONS.map((s) => ({
          to: `/apps/${appEnv}/${appId}?section=${s.key}`,
          label: s.label,
          icon: SECTION_ICON[s.key],
          group: s.group,
          active: section === s.key,
        })),
      ]
    : [
        { to: "/", label: "Apps", icon: AppWindow },
        ...(isAdmin ? [{ to: "/admin", label: "Admin", icon: ShieldCheck }] : []),
      ];

  return (
    <Shell
      nav={nav}
      footer={
        <>
          <span className="hidden w-full truncate px-3 pb-1 text-xs text-muted-foreground md:block" title={pid}>
            {pid}
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === "testnet" ? "mainnet" : "testnet")}
            className={cn(RAIL_TILE, "md:w-full")}
          >
            <FlaskConical className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{env !== "production" ? "Mainnet" : "Testnet"}</span>
          </button>
          <Link to="/demo" className={cn(RAIL_TILE, "md:w-full")}>
            <FlaskConical className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">Demo app</span>
          </Link>
          <button type="button" onClick={() => void signOut()} className={cn(RAIL_TILE, "md:w-full")}>
            <LogOut className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">Sign out</span>
          </button>
        </>
      }
    >
      <Outlet />
    </Shell>
  );
}
