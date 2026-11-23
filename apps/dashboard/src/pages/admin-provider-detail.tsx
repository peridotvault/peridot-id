import { Link, useParams } from "react-router";
import { ProviderDetail } from "../feat/admin/provider-detail";
import { useWorkspace } from "../shared/components/workspace-provider";
import { MUTED } from "../shared/ui/kit";

/** One provider, focused (/admin/providers/:code). */
export default function AdminProviderDetailPage() {
  const { client } = useWorkspace();
  const { code = "" } = useParams();

  if (!code) {
    return (
      <p className={`text-sm ${MUTED}`}>
        Provider not found. <Link to="/admin/providers" className="text-muted-foreground transition-colors hover:text-foreground">Back to providers</Link>
      </p>
    );
  }

  return <ProviderDetail client={client} code={code} />;
}
