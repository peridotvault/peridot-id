import { EditChainForm } from "../workspace/edit-chain-form";
import { Card } from "../workspace/ui";
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
