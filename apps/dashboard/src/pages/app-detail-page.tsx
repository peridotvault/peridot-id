import { Link, useParams } from "react-router";
import type { DashboardMode } from "../shared/lib/config";
import { AppDetail } from "../feat/workspace/app-detail";
import { AppUsers } from "../feat/app-users/AppUsers";
import { AppXpTasks } from "../feat/app-xp/AppXpTasks";
import { useWorkspace } from "../shared/components/workspace-provider";
import { MUTED } from "../shared/ui/kit";

/** One app: settings, keys, domains, branding, fees. Chrome lives in WorkspaceLayout. */
export default function AppDetailPage() {
  const { clientFor } = useWorkspace();
  // The route carries the app's own network: app ids are unique per DB, and
  // the numbers on the page (XP, fees, balance) must come from that DB.
  const { env = "mainnet", id = "" } = useParams();
  const appEnv: DashboardMode = env === "testnet" ? "testnet" : "mainnet";
  const client = clientFor(appEnv);
  const appId = Array.isArray(id) ? id[0] : (id ?? "");

  // ANT-341 FR7: empty app id is validated client-side — never "" → API 404 path.
  if (!appId) {
    return (
      <p className={`text-sm ${MUTED}`}>
        Missing app id.{" "}
        <Link to="/" className="text-muted-foreground transition-colors hover:text-foreground">
          Back to apps
        </Link>
      </p>
    );
  }

  return (
    <AppDetail
      key={`${appEnv}:${appId}`}
      client={client}
      appId={appId}
      users={<AppUsers key={`users:${appEnv}:${appId}`} client={client} appId={appId} />}
      xp={<AppXpTasks key={`xp:${appEnv}:${appId}`} client={client} appId={appId} />}
    />
  );
}
