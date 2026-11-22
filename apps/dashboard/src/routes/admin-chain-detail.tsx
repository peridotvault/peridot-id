import { useParams } from "react-router";
import { ChainDetail } from "../feat/admin/chain-detail";
import { useWorkspace } from "../workspace/workspace-provider";

/** One chain, focused, with General / Contracts / Tokens tabs. */
export default function AdminChainDetailPage() {
  const { client } = useWorkspace();
  const { id = "" } = useParams();
  return <ChainDetail client={client} chainId={id} />;
}
