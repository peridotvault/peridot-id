import { EditChainForm } from "../feat/workspace/edit-chain-form";
import { Card } from "../shared/ui/kit";
import { useChainDetail } from "../feat/admin/chain-detail";

/** General tab: metadata, RPCs, logo, availability. */
export default function AdminChainGeneralPage() {
  const { client, chain, reload } = useChainDetail();
  return (
    <Card>
      <EditChainForm client={client} chain={chain} onDone={() => void reload()} />
    </Card>
  );
}
