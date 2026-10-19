import { permanentRedirect } from "next/navigation";

// Redirect shim (spec ANT-83 §1.3): the developer workspace moved to the
// standalone dashboard app (`apps/dashboard`). Every /workspace* request
// redirects there preserving the sub-path (/workspace/apps/X →
// {DASHBOARD_URL}/apps/X) via a permanent (308) redirect. No session logic,
// no UI — a shim, not a fork. Delete in a follow-up once inbound /workspace
// traffic is confirmed zero.
const DASHBOARD_URL = (process.env.NEXT_PUBLIC_PID_DASHBOARD_URL ?? "http://localhost:3303").replace(/\/$/, "");

export default async function WorkspaceRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path = [] } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, v);
    } else if (value !== undefined) {
      query.append(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  permanentRedirect(`${DASHBOARD_URL}/${path.join("/")}${suffix}`);
}
