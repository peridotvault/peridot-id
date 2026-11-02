import { useNetworkMode } from "../../../shared/hooks/useNetworkMode";
import { useSelectedChains } from "../../../shared/hooks/useSelectedChains";

const ALL = "all";
const CUSTOM = "custom";

// Chain picker for the asset group: All chains, or exactly one registry chain.
// Backed by the selectedChains store, which persists to localStorage
// (`pid_selected_chains`) and reloads the data hooks on change. A multi-chain
// custom set (made in Settings) shows as one "Custom" entry so the control can
// still represent it.
export function ChainSelect() {
  const sel = useSelectedChains();
  const net = useNetworkMode();
  const single =
    sel.selection.mode === "custom" && sel.selection.chains.length === 1 ? sel.selection.chains[0] : null;
  const value =
    sel.selection.mode === "all" ? ALL : single ? `${single.namespace}:${single.reference}` : CUSTOM;

  return (
    <select
      aria-label="Chains"
      value={value}
      disabled={net.switching}
      onChange={(e) => {
        const next = e.target.value;
        if (next === ALL) {
          sel.setAll();
          return;
        }
        if (next === CUSTOM) return;
        const [namespace, ...rest] = next.split(":");
        sel.setCustom([{ namespace, reference: rest.join(":") }]);
      }}
      className="border border-border bg-background px-2.5 py-1.5 font-sans text-xs text-foreground hover:bg-surface disabled:opacity-40"
    >
      <option value={ALL}>All chains</option>
      {value === CUSTOM && <option value={CUSTOM}>{sel.label}</option>}
      {sel.chains.map((c) => (
        <option key={`${c.namespace}:${c.reference}`} value={`${c.namespace}:${c.reference}`}>
          {c.name}
          {c.isTestnet ? " (testnet)" : ""}
        </option>
      ))}
    </select>
  );
}
