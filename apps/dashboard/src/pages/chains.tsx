import { ChainsManager } from "../feat/workspace/chains-manager";
import { useWorkspace } from "../shared/components/workspace-provider";

/** Admin chain registry (path: /admin/chains). */
export default function WorkspaceChainsPage() {
  const { client } = useWorkspace();
  return <ChainsManager client={client} />;
}
