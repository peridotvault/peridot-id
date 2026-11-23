import { useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { AddChainForm } from "../feat/workspace/add-chain-form";
import { PageHeader } from "../shared/ui/page-header";
import { useWorkspace } from "../shared/components/workspace-provider";
import { MUTED } from "../shared/ui/kit";

/** Register a new EVM chain. Chrome lives in WorkspaceLayout. */
export default function ChainsCreatePage() {
  const { client } = useWorkspace();
  const navigate = useNavigate();
  useEffect(() => {
    document.title = "Add chain · Dashboard · PeridotID";
  }, []);

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
