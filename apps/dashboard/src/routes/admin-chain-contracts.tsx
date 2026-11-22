import { ChainContracts } from "../feat/admin/chain-contracts";
import { useChainDetail } from "../feat/admin/chain-detail";

/** Contracts tab: factory / account implementation for this chain. */
export default function AdminChainContractsPage() {
  const { client, chain, reload } = useChainDetail();
  return <ChainContracts client={client} chain={chain} onChanged={reload} />;
}
