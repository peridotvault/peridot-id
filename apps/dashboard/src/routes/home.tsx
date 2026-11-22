import { AppsManager } from "../workspace/apps-manager";
import { useWorkspace } from "../workspace/workspace-provider";

/** Apps list. Session gates and the console chrome live in WorkspaceLayout. */
export default function WorkspacePage() {
  const { client } = useWorkspace();
  return <AppsManager client={client} />;
}
