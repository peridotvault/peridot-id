import type { Metadata } from "next";
import { EditChainView } from "./edit-view";

export const metadata: Metadata = {
  title: "Edit chain · Workspace · PeridotID",
};

export default function WorkspaceChainsEditPage() {
  return <EditChainView />;
}
