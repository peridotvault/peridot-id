import { ProvidersAdmin } from "../feat/admin/providers-admin";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../shared/components/workspace-provider";

export default function AdminProvidersPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage
      eyebrow="Admin"
      title="Providers"
      description="Login providers, OAuth clients and per-family wallet chain support."
    >
      <ProvidersAdmin client={client} />
    </AdminPage>
  );
}
