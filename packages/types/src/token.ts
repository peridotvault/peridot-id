/** Curated token: GLOBAL metadata once (symbol/name/logo). */
export interface Token {
  id: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deployments: TokenDeployment[];
}

/** One token on one chain (chain picked from the chains table). */
export interface TokenDeployment {
  id: string;
  tokenId: string;
  chainId: string;
  chainNamespace: string;
  chainReference: string;
  chainName: string;
  mint: string;
  decimals: number;
  isVisible: boolean;
  isPinned: boolean;
  sortOrder: number;
}

/** Flat public row (same shape wallets already consume). */
export interface RegistryToken {
  id: string;
  chainNamespace: string;
  chainReference: string;
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  isVisible: boolean;
  isPinned: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TokenDeploymentInput {
  /** chains.id (dashboard picks from the chains table). */
  chainId: string;
  mint: string;
  decimals: number;
  isVisible?: boolean;
  isPinned?: boolean;
  sortOrder?: number;
}

export interface CreateTokenInput {
  symbol: string;
  name: string;
  /** Preview-suggested CoinGecko image (server fetches it into Wasabi). */
  logoSourceUrl?: string;
  deployments: TokenDeploymentInput[];
}

export interface UpdateTokenInput {
  symbol?: string;
  name?: string;
}

export interface UpdateTokenDeploymentInput {
  decimals?: number;
  isVisible?: boolean;
  isPinned?: boolean;
  sortOrder?: number;
}

/** Admin double-check + autofill for a candidate mint (never auto-saved). */
export interface TokenPreview {
  chainNamespace: string;
  chainReference: string;
  mint: string;
  onchain: { decimals?: number; error?: string };
  coingecko: {
    id: string;
    symbol: string;
    name: string;
    imageUrl: string | null;
    decimalPlace: number | null;
    addressMatch: boolean;
  } | null;
  coingeckoSkipped?: string;
  autofill: { symbol: string; name: string; decimals: number | null; logoSourceUrl: string | null } | null;
  conflicts: string[];
}
