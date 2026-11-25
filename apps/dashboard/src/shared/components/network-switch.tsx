import { ArrowLeftRight } from "lucide-react";
import { RAIL_TILE } from "./shell";
import { useWorkspace } from "./workspace-provider";
import { cn } from "../lib/cn";

/**
 * Sidebar network switch (bottom row). Stores `pid_network_mode` and reloads —
 * the API origin is fixed per page load, so nothing straddles two networks.
 */
export function NetworkSwitch() {
  const { mode, setMode } = useWorkspace();
  const target = mode === "testnet" ? "mainnet" : "testnet";
  return (
    <button
      type="button"
      title={`Switch to ${target} — reloads the dashboard`}
      onClick={() => setMode(target)}
      className={cn(RAIL_TILE, "md:w-full")}
    >
      <ArrowLeftRight className="size-4 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">Switch to {target}</span>
      <span className="sr-only"> (currently {mode})</span>
    </button>
  );
}
