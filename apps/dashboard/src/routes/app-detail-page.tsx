import { Link, useParams } from "react-router";
import { AppDetail } from "../workspace/app-detail";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

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

  return <AppDetail key={appId} client={client} appId={appId} />;
}
