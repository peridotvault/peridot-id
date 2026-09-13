import { Suspense } from "react";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { HeroWaves } from "@/components/landing/hero-waves";
import { WorkspaceProvider, WorkspaceTopbar } from "./_components/workspace-provider";

export const metadata: Metadata = {
  title: "Workspace · PeridotID",
};

/** Workspace-only layout: fixed animated backdrop + session topbar around every state. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 -z-10 overflow-hidden">
        <HeroWaves />
      </div>
      <Suspense fallback={null}>
        <WorkspaceProvider>
          <WorkspaceTopbar />
          {children}
        </WorkspaceProvider>
      </Suspense>
    </>
  );
}
