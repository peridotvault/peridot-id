import { AppsManager } from "../feat/workspace/apps-manager";
import { useWorkspace } from "../shared/components/workspace-provider";

/** Apps list. Session gates and the console chrome live in WorkspaceLayout. */
export default function WorkspacePage() {
  const { client } = useWorkspace();
  return <AppsManager client={client} />;
}
