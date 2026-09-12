// EVM chain-account helpers (counterfactual CREATE2 accounts, one address per
// pidAccount.id across every configured eip155 chain — the Solana PDA split).

import { EVM_CHAINS, type EvmChain } from "@peridotvault/pid-core/dist/evm";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(v: string | undefined): v is string {
  return typeof v === "string" && ADDRESS_RE.test(v);
}

/** Chains to provision, optionally narrowed by `EVM_CHAIN_REFERENCES` csv. */
export function evmChains(allowlist?: string): EvmChain[] {
  if (!allowlist) return EVM_CHAINS;
  const refs = new Set(allowlist.split(",").map((s) => s.trim()).filter(Boolean));
  return EVM_CHAINS.filter((c) => refs.has(c.chainReference));
}

export function evmChainByReference(chainReference: string): EvmChain | undefined {
  return EVM_CHAINS.find((c) => c.chainReference === chainReference);
}
