import { FeesManager } from "../feat/workspace/fees-manager";
import { useWorkspace } from "../shared/components/workspace-provider";

/** Admin fees console (path: /admin/fees). */
export default function WorkspaceFeesPage() {
  const { client } = useWorkspace();
  return <FeesManager client={client} />;
}
