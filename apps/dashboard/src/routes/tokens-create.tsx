import { useEffect } from "react";
import { Link } from "react-router";
import { useNavigate } from "react-router";
import { AddTokenForm } from "../workspace/add-token-form";
import { PageHeader } from "../workspace/page-header";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

export function CreateTokenView() {
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
        eyebrow="Token registry"
        title="Add token"
        description="Check the mint on-chain and CoinGecko, then register it."
      />
      <div className="mt-4">
        <AddTokenForm client={client} onDone={() => navigate("/tokens")} onError={() => {}} />
      </div>
      <p className={`mt-4 text-sm ${MUTED}`}>
        <Link to="/tokens" className="underline">Back to tokens</Link>
      </p>
    </main>
  );
}

export default function TokensCreatePage() {
  useEffect(() => {
    document.title = "Add token · Dashboard · PeridotID";
  }, []);
  return <CreateTokenView />;
}
