import { useEffect } from "react";
import { EditChainView } from "./chains-edit-view";

export default function ChainsEditPage() {
  useEffect(() => {
    document.title = "Edit chain · Dashboard · PeridotID";
  }, []);
  return <EditChainView />;
}
