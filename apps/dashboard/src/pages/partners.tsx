import { PartnersManager } from "../feat/workspace/partners-manager";
import { useWorkspace } from "../shared/components/workspace-provider";

/** Admin partner directory (path: /admin/partners). */
export default function WorkspacePartnersPage() {
  const { client } = useWorkspace();
  return <PartnersManager client={client} />;
}
