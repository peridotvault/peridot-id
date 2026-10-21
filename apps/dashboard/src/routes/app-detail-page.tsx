
import { useParams } from "react-router";
import { AppDetail } from "../workspace/app-detail";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

/** App Detail: your fiat balance, allowed origins, backend secret, per-app fee schedule. */
export default function AppDetailPage() {
  const { client, status } = useWorkspace();
  const { id = "" } = useParams();
  const appId = Array.isArray(id) ? id[0] : (id ?? "");

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
        <p className={`mt-8 text-sm ${MUTED}`}>Sign in to manage this app.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <AppDetail key={appId} client={client} appId={appId} />
    </main>
  );
}
