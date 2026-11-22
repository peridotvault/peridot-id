import { FeesManager } from "../workspace/fees-manager";
import { useWorkspace } from "../workspace/workspace-provider";

/** Admin fees console (path: /admin/fees). */
export default function WorkspaceFeesPage() {
  const { client } = useWorkspace();
  return <FeesManager client={client} />;
}
