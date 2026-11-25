import { Link, Outlet } from "react-router";
import { ArrowLeft, BookOpen, Handshake, Layers, Link2, LogIn, LogOut, Plug, Receipt, Settings, Trophy, Users } from "lucide-react";
import { Card, ERROR, MUTED, MiniButton } from "../../shared/ui/kit";
import { RAIL_TILE, Shell } from "../../shared/components/shell";
import { NetworkSwitch } from "../../shared/components/network-switch";
import { useWorkspace } from "../../shared/components/workspace-provider";
import { cn } from "../../shared/lib/cn";

const NAV = [
  { to: "/admin/providers", label: "Providers", icon: Plug },
  { to: "/admin/chain-families", label: "Chain families", icon: Layers },
  { to: "/admin/chains", label: "Chains", icon: Link2 },
  { to: "/admin/fees", label: "Fees", icon: Receipt },
  { to: "/admin/partners", label: "Partners", icon: Handshake },
  { to: "/admin/login-activity", label: "Login activity", icon: LogIn },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/ledger", label: "Ledger", icon: BookOpen },
  { to: "/admin/leveling", label: "Leveling", icon: Trophy },
  { to: "/admin/settings", label: "System", icon: Settings },
];

/**
 * `/admin/*` gate + sidebar. The API rejects anonymous, non-admin and machine
 * tokens on every call (AdminGuard) — this guard only avoids dead ends.
 */
export function AdminLayout() {
  const { status, isAdmin, env, busy, error, signIn } = useWorkspace();
  const sandbox = env !== "production";

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
        <Card>
          <h1 className="text-base font-semibold tracking-tight">Admin — sign in to continue</h1>
          <p className={`mt-1 text-sm ${MUTED}`}>This area requires an admin identity.</p>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <MiniButton variant="solid" size="lg" type="button" onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : "Sign in with PeridotID"}
            </MiniButton>
            <Link to="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to workspace</Link>
          </div>
        </Card>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main id="main-content" className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
        <p className={`text-sm ${MUTED}`}>
          Admin only. <Link to="/" className="text-muted-foreground transition-colors hover:text-foreground">Back to workspace</Link>
        </p>
      </main>
    );
  }

  return (
    <Shell
      nav={NAV}
      footer={
        <>
          <Link to="/" className={cn(RAIL_TILE, "md:w-full")}>
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">Workspace</span>
          </Link>
          <NetworkSwitch />
        </>
      }
    >
      <Outlet />
    </Shell>
  );
}
