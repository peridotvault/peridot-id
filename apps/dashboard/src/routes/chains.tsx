
import { Link } from "react-router";
import { ChainsManager } from "../workspace/chains-manager";
import { useWorkspace } from "../workspace/workspace-provider";
import { MUTED } from "../workspace/ui";

/** Admin chain grid. */
export default function WorkspaceChainsPage() {
  const { client, status, isAdmin } = useWorkspace();

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
      <ChainsManager client={client} />
    </main>
  );
}
