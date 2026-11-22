import type { ReactNode } from "react";
import { PageHeader } from "../../workspace/page-header";

/** Admin page body: header + content. Session and admin gates live in AdminLayout. */
export function AdminPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </>
  );
}
