import { UsersAdmin } from "../feat/admin/users-admin";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../shared/components/workspace-provider";

export default function AdminUsersPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage
      eyebrow="Admin"
      title="Users"
      description="Every identity with its fiat balance, login method and last login. Read only."
    >
      <UsersAdmin client={client} />
    </AdminPage>
  );
}
