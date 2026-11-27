import { LedgerDanger } from "../feat/admin/ledger-danger";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../shared/components/workspace-provider";

export default function AdminLedgerDangerPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage
      eyebrow="Admin / Ledger"
      title="Ledger operations"
      description="Danger zone: the freeze switch, hash-chain backfill and balanced adjustments."
    >
      <LedgerDanger client={client} />
    </AdminPage>
  );
}
