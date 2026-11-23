import { Link, useParams } from "react-router";
import { AppDetail } from "../feat/workspace/app-detail";
import { AppUsers } from "../feat/app-users/AppUsers";
import { AppXpTasks } from "../feat/app-xp/AppXpTasks";
import { useWorkspace } from "../shared/components/workspace-provider";
import { MUTED } from "../shared/ui/kit";

/** One app: settings, keys, domains, branding, fees. Chrome lives in WorkspaceLayout. */
export default function AppDetailPage() {
  const { client } = useWorkspace();
  const { id = "" } = useParams();
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
      key={appId}
      client={client}
      appId={appId}
      users={<AppUsers key={`users:${appId}`} client={client} appId={appId} />}
      xp={<AppXpTasks key={`xp:${appId}`} client={client} appId={appId} />}
    />
  );
}
