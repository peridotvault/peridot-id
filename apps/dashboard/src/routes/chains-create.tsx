import { useEffect } from "react";
import { CreateChainView } from "./chains-create-view";

export default function ChainsCreatePage() {
  useEffect(() => {
    document.title = "Add chain · Dashboard · PeridotID";
  }, []);
  return <CreateChainView />;
}
