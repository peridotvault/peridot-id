import { PartnersManager } from "../workspace/partners-manager";
import { useWorkspace } from "../workspace/workspace-provider";

/** Admin partner directory (path: /admin/partners). */
export default function WorkspacePartnersPage() {
  const { client } = useWorkspace();
  return <PartnersManager client={client} />;
}
