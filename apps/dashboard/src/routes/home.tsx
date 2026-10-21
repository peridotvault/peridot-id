
import { AppsManager } from "../workspace/apps-manager";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED } from "../workspace/ui";
import { PageHeader } from "../workspace/page-header";
import { CutButton } from "../workspace/cut-button";

/** Session gate: logged-out visitors get the login section, owners get Apps. */
export default function WorkspacePage() {
  const {
    client,
    status,
    busy,
    error,
    signIn,
  } = useWorkspace();

  if (status === "checking") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="PeridotID for developers" title="Workspace" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to manage your apps</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Register <code>client_id</code>s, edit allowed origins, and generate backend secrets.
          </p>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
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

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppsManager client={client} />
    </main>
  );
}
