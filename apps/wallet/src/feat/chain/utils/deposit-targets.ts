import type { ChainAccount } from "@peridotvault/pid-types";

export interface DepositTarget {
  key: string;
  label: string;
  sublabel: string;
  address: string;
  qrValue: string;
}

// ponytail: display names live here until the API exposes registry metadata to users.
const EVM_LABELS: Record<string, { label: string; asset: string }> = {
  "10143": { label: "Monad Testnet", asset: "MON" },
  "97": { label: "BNB Testnet", asset: "tBNB" },
  "421614": { label: "Arbitrum Sepolia", asset: "ETH" },
  "84532": { label: "Base Sepolia", asset: "ETH" },
};

export function buildDepositTargets(accounts: ChainAccount[]): DepositTarget[] {
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
    const meta = EVM_LABELS[c.chainReference] ?? { label: `EVM ${c.chainReference}`, asset: "native" };
    return {
      key: `eip155-${c.chainReference}`,
      label: meta.label,
      sublabel: meta.asset,
      address: c.address,
      qrValue: c.address,
    };
  });
}
