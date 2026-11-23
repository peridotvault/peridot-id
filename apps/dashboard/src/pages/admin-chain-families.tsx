import { ChainFamiliesAdmin } from "../feat/admin/chain-families-admin";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../shared/components/workspace-provider";

export default function AdminChainsPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage eyebrow="Admin" title="Chain families" description="Signing namespaces and the chains they contain.">
      <ChainFamiliesAdmin client={client} />
    </AdminPage>
  );
}
