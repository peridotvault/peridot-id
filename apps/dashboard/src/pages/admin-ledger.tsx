import { LedgerAdmin } from "../feat/admin/ledger-admin";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../shared/components/workspace-provider";

export default function AdminLedgerPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage
      eyebrow="Admin"
      title="Ledger"
      description="Fiat ledger replay, per-PID balances and hash-chain integrity. Read only."
    >
      <LedgerAdmin client={client} />
    </AdminPage>
  );
}
