
import { Link, useParams } from "react-router";
import { AppDetail } from "../workspace/app-detail";
import { useWorkspace } from "../workspace/workspace-provider";
import { Card, ERROR, MUTED } from "../workspace/ui";
import { PageHeader } from "../workspace/page-header";
import { CutButton } from "../workspace/cut-button";

/** App Detail: your fiat balance, allowed origins, backend secret, per-app fee schedule. */
export default function AppDetailPage() {
  const { client, status, busy, error, signIn } = useWorkspace();
  const { id = "" } = useParams();
  const appId = Array.isArray(id) ? id[0] : (id ?? "");

  if (status === "checking") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`mt-8 text-sm ${MUTED}`}>Checking session…</p>
      </main>
    );
  }
  // ANT-341 FR5: anonymous visitors get a sign-in CTA (no dead-ends).
  if (status === "anonymous") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <PageHeader eyebrow="Developer" title="App detail" />
        <Card className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to manage this app</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>App settings require a signed-in session.</p>
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

  // ANT-341 FR7: empty app id is validated client-side — never "" → API 404 path.
  if (!appId) {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
        <p className={`mt-8 text-sm ${MUTED}`}>
          Missing app id. <Link to="/" className="underline">Back to workspace</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppDetail key={appId} client={client} appId={appId} />
    </main>
  );
}
