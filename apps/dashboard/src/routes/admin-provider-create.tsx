import { ProviderCreate } from "../feat/admin/provider-create";
import { useWorkspace } from "../workspace/workspace-provider";

/** Add a provider (/admin/providers/new). */
export default function AdminProviderCreatePage() {
  const { client } = useWorkspace();
  return <ProviderCreate client={client} />;
}
