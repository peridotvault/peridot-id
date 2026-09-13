import type { Metadata } from "next";
import { CreateChainView } from "./create-view";

export const metadata: Metadata = {
  title: "Add chain · Workspace · PeridotID",
};

export default function WorkspaceChainsCreatePage() {
  return <CreateChainView />;
}
