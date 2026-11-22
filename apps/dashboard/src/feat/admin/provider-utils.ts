import type { ProviderMeta } from "../../workspace/app-types";

export interface AdminProvider extends ProviderMeta {
  configSource: "database" | "environment" | "none" | "adapter";
  oauth: null | {
    clientId: string;
    scopes: string[];
    redirectUri: string;
    secretUpdatedAt: string;
    hasSecret: boolean;
  };
  chainPolicies?: Array<{
    namespace: string;
    mode: "all" | "selected";
    selections: Array<{ chain: { id: string; namespace: string; reference: string; name: string | null; isActive: boolean } }>;
  }>;
}

export interface ChainFamilyRow {
  code: string;
  chains: Array<{ id: string; namespace: string; reference: string; name: string | null; isActive: boolean }>;
}

/** One readiness sentence for the admin table. Never claims unshipped support. */
export function readiness(provider: AdminProvider): { label: string; tone: "ready" | "warn" | "off" } {
  if (!provider.isSupported) return { label: "Adapter missing", tone: "warn" };
  if (!provider.isConfigured) return { label: "Not configured", tone: "warn" };
  if (!provider.isAvailable) return { label: "Disabled", tone: "off" };
  return { label: "Ready", tone: "ready" };
}

/** Expected icon fallback: true when the catalogue has no usable asset URL. */
export function needsIconFallback(imageUrl: string | null): boolean {
  return !imageUrl || imageUrl.trim() === "";
}

export function groupByCategory(rows: AdminProvider[]): Record<"web2" | "web3", AdminProvider[]> {
  return {
    web2: rows.filter((row) => row.category === "web2"),
    web3: rows.filter((row) => row.category === "web3"),
  };
}

/** Chain policy summary — empty selected mode is "unconfigured", not "all chains". */
export function policySummary(policy: NonNullable<AdminProvider["chainPolicies"]>[number]): string {
  if (policy.mode === "all") return "All chains in family";
  if (policy.selections.length === 0) return "Unconfigured (no chains selected)";
  return policy.selections
    .map((selection) => selection.chain.name ?? `${selection.chain.namespace}:${selection.chain.reference}`)
    .join(", ");
}
