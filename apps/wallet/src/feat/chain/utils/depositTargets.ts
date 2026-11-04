import type { Chain, ChainAccount } from "@peridotvault/pid-types";

export interface DepositTarget {
  key: string;
  label: string;
  sublabel: string;
  address: string;
  qrValue: string;
}

// ponytail: offline fallback labels — registry rows (GET /v1/chains, managed in
// the dashboard) win so a newly registered chain shows its real name/symbol.
const EVM_LABELS: Record<string, { label: string; asset: string }> = {
  "10143": { label: "Monad Testnet", asset: "MON" },
  "97": { label: "BNB Testnet", asset: "tBNB" },
  "421614": { label: "Arbitrum Sepolia", asset: "ETH" },
  "84532": { label: "Base Sepolia", asset: "ETH" },
};

function registryRow(chains: Chain[], namespace: string, reference: string): Chain | undefined {
  return chains.find((c) => c.namespace === namespace && c.reference === reference);
}

/** Deposit cards for the wallet's smart-account rows. `chains` is the
 *  registry list (optional — labels fall back to the built-in table). */
export function buildDepositTargets(accounts: ChainAccount[], chains: Chain[] = []): DepositTarget[] {
  const rows = (accounts ?? []).filter((c) => c.accountType === "smart_account");
  return rows.map((c, i) => {
    if (c.chainNamespace === "solana") {
      return {
        key: `solana-${i}`,
        label: "Solana",
        sublabel: "SOL or SPL tokens",
        address: c.address,
        qrValue: `solana:${c.address}`,
      };
    }
    const known = registryRow(chains, "eip155", c.chainReference);
    const fallback = EVM_LABELS[c.chainReference];
    return {
      key: `eip155-${c.chainReference}`,
      label: known?.name ?? fallback?.label ?? `EVM ${c.chainReference}`,
      sublabel: known?.nativeSymbol ?? fallback?.asset ?? "native",
      address: c.address,
      qrValue: c.address,
    };
  });
}
