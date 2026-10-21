
import { Link } from "react-router";
import { useNavigate } from "react-router";
import { AddChainForm } from "../workspace/add-chain-form";
import { PageHeader } from "../workspace/page-header";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

export function CreateChainView() {
  const { client, status, isAdmin } = useWorkspace();
  const navigate = useNavigate();

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`text-sm ${MUTED}`}>
          Admin only. <Link to="/" className="underline">Back to workspace</Link>
        </p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <PageHeader
        eyebrow="Chain registry"
        title="Add chain"
        description="Register a new EVM chain in the wallet registry."
      />
      <div className="mt-4">
        <AddChainForm client={client} onDone={() => navigate("/chains")} onError={() => {}} />
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link to="/chains" className="underline">Back to chains</Link>
      </p>
    </main>
  );
}
