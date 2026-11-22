
import { Link } from "react-router";
import { useNavigate } from "react-router";
import { AddChainForm } from "../workspace/add-chain-form";
import { PageHeader } from "../workspace/page-header";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

export function CreateChainView() {
  const { client } = useWorkspace();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        eyebrow="Chain registry"
        title="Add chain"
        description="Register a new EVM chain in the wallet registry."
      />
      <div className="mt-4">
        <AddChainForm client={client} onDone={() => navigate("/admin/chains")} onError={() => {}} />
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link to="/admin/chains" className="text-muted-foreground transition-colors hover:text-foreground">Back to chains</Link>
      </p>
    </>
  );
}
