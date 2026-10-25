export interface ChainContract {
  id: string;
  chainId: string;
  type: string;
  address: string;
  versionLabel: string | null;
  deployTxHash: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Chain {
  id: string;
  namespace: string;
  reference: string;
  name: string;
  nativeSymbol: string;
  decimals: number;
  rpcUrls: string[];
  explorerUrl: string | null;
  logoUrl: string | null;
  isTestnet: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  contracts?: ChainContract[];
}

export interface CreateChainInput {
  namespace: "solana" | "eip155";
  reference: string;
  name: string;
  nativeSymbol: string;
  decimals?: number;
  rpcUrls?: string[];
  explorerUrl?: string;
  logoUrl?: string;
  isTestnet?: boolean;
}

export interface UpdateChainInput {
  name?: string;
  nativeSymbol?: string;
  decimals?: number;
  rpcUrls?: string[];
  explorerUrl?: string;
  logoUrl?: string;
  isTestnet?: boolean;
  isActive?: boolean;
}

export interface UpsertContractInput {
  type: "factory" | "account_implementation" | "verifier" | "paymaster" | "program";
  address: string;
  versionLabel?: string;
  deployTxHash?: string;
  isActive?: boolean;
}

/** Admin double-check for a chain row (RPC truth + free metadata suggest). */
export interface ChainPreview {
  chainNamespace: string;
  reference: string;
  rpcUrl: string;
  rpc: { ok: boolean; chainId?: string; genesisHash?: string; error?: string };
  suggest: { name?: string; nativeSymbol?: string; explorerUrl?: string } | null;
  conflicts: string[];
}

export interface ChainAccount {
  id: string;
  chainNamespace: string;
  chainReference: string;
  address: string;
  accountType: "smart_account" | "linked_address";
  status: "inactivated" | "funded" | "ready" | "activating" | "active" | "insufficient";
  activationBalance: number | null;
  activationRequired: number | null;
  createdAt: string;
}
