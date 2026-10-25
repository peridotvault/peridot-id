
import { Link } from "react-router";
import { ChainsManager } from "../workspace/chains-manager";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED } from "../workspace/ui";
import { PageHeader } from "../workspace/page-header";
import { CutButton } from "../workspace/cut-button";

/** Admin chain grid. */
export default function WorkspaceChainsPage() {
  const { client, status, isAdmin, busy, error, signIn } = useWorkspace();

  if (status === "checking") {
    return (
      <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p role="status" className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  // ANT-341 FR5: anonymous visitors get a sign-in CTA (no dead-ends);
  // signed-in non-admins get Admin only.
  if (status === "anonymous") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Chain registry" title="Chains" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to manage chains</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>The chain registry is admin-only.</p>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-4">
            <CutButton
              type="button"
              onClick={signIn}
              disabled={busy}
              className={busy ? "pointer-events-none opacity-60" : ""}
            >
              {busy ? "Waiting for wallet…" : "Sign in with PeridotID"}
            </CutButton>
          </div>
        </Card>
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
      <ChainsManager client={client} />
    </main>
  );
}
