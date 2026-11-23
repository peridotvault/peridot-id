import { ChainTokens } from "../feat/admin/chain-tokens";
import { useChainDetail } from "../feat/admin/chain-detail";

/** Tokens tab: deployments on this chain, visibility, and registration. */
export default function AdminChainTokensPage() {
  const { client, chain, reload } = useChainDetail();
  return <ChainTokens client={client} chain={chain} onChanged={reload} />;
}
