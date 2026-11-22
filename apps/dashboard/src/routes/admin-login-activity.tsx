import { LoginActivityAdmin } from "../feat/admin/login-activity-admin";
import { AdminPage } from "../feat/admin/admin-page";
import { useWorkspace } from "../workspace/workspace-provider";

export default function AdminLoginActivityPage() {
  const { client } = useWorkspace();
  return (
    <AdminPage
      eyebrow="Admin"
      title="Login activity"
      description="Who signed in, with which provider, and how that provider was established."
    >
      <LoginActivityAdmin client={client} />
    </AdminPage>
  );
}
