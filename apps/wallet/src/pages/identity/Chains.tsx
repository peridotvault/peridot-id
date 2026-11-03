import { useCallback } from "react";
import { LayoutGrid } from "../../shared/components/icons";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { Retry } from "../../shared/components/ui/Retry";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { ToggleRow } from "../../shared/components/ui/ToggleRow";
import { isChainSelected } from "../../shared/data/selectedChains";
import { useSelectedChains } from "../../shared/hooks/useSelectedChains";

// Chain selection (ANT-625 FR1): master All-chains row + one row per registry
// chain. Lives on its own page — Settings keeps a single "Chains" row in the
// Network group. Toggles write the selectedChains store (persisted in
// localStorage, signed payloads stay blocked while the switch propagates).
export function Chains({ onDone }: { onDone: () => void }) {
  const sel = useSelectedChains();

  const toggleMaster = useCallback(() => {
    if (sel.selection.mode === "all") {
      // Custom covering every known row: no visible change, and the user can
      // now deselect rows one by one. Refresh first when rows are still
      // loading so the set is built from live registry data.
      if (sel.chains.length === 0) {
        sel.retryChains();
        return;
      }
      sel.setCustom(sel.chains.map((c) => ({ namespace: c.namespace, reference: c.reference })));
    } else {
      sel.setAll();
    }
  }, [sel]);

  return (
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader
            onBack={onDone}
            title="Chains"
            subtitle="Pick which chains this wallet loads. Saved on this device."
          />
        </SectionHead>
      </Section>

      <Section>
        <div className="px-6 pb-4 pt-2">
          <p className="font-sans text-xs text-muted-foreground">
            {sel.selection.mode === "all"
              ? "Showing all chains — data loads for every available chain."
              : `Showing ${sel.label} — data loads only for selected chains.`}
          </p>

          {sel.notice && (
            <p role="status" className="mt-2 font-sans text-sm text-muted-foreground">{sel.notice}</p>
          )}

          <div className="mt-3 divide-y divide-line border border-border bg-background">
            <ToggleRow
              icon={LayoutGrid}
              label="All chains"
              hint={sel.selection.mode === "all" ? "On — using every chain" : "Off — custom selection below"}
              on={sel.selection.mode === "all"}
              onPress={toggleMaster}
              className="px-4"
            />

            {sel.chains.map((c) => (
              <ToggleRow
                key={`${c.namespace}:${c.reference}`}
                icon={LayoutGrid}
                label={c.name}
                hint={`${c.namespace}:${c.reference.slice(0, 8)}${c.reference.length > 8 ? "…" : ""}`}
                testnet={c.isTestnet}
                on={isChainSelected(sel.selection, c.namespace, c.reference)}
                onPress={() => sel.toggle(c.namespace, c.reference)}
                className="px-4"
              />
            ))}
          </div>

          {sel.chainsError && (
            <div className="mt-2">
              <span role="alert" className="font-sans text-sm text-muted-foreground">
                Couldn&apos;t load the chain list ({sel.chainsError}) — showing your saved selection. Retry to refresh.
              </span>
              <Retry onPress={sel.retryChains} label="Retry loading chains" />
            </div>
          )}

          {sel.chains.length === 0 && !sel.chainsError && (
            <span role="status" className="mt-2 block font-sans text-sm text-muted-foreground">Loading chains…</span>
          )}
        </div>
      </Section>
    </div>
  );
}
