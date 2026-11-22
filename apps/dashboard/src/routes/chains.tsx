import { ChainsManager } from "../workspace/chains-manager";
import { useWorkspace } from "../workspace/workspace-provider";

/** Admin chain registry (path: /admin/chains). */
export default function WorkspaceChainsPage() {
  const { client } = useWorkspace();
  return <ChainsManager client={client} />;
}
