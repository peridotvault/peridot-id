export type IdentityStatus = "active" | "suspended" | "deleted";

export interface Identity {
  id: string;
  status: IdentityStatus;
  createdAt: string;
}

export interface Profile {
  id: string;
  identityId: string;
  username: string | null;
  usernameChangedAt: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileUpdate {
  username?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
}

export interface IdentityCredential {
  id: string;
  provider: string;
  email: string | null;
  linkedAt: string;
  lastLoginAt: string | null;
}

export interface LoginResponse {
  url: string;
}

export interface Wallet {
  id: string;
  chain: string;
  address: string;
  status: IdentityStatus;
  createdAt: string;
}

export interface WalletCreate {
  address: string;
}

export interface ChainAccount {
  id: string;
  chainNamespace: string;
  chainReference: string;
  address: string;
  accountType: "smart_account" | "linked_address";
  status: IdentityStatus;
  createdAt: string;
}

export interface Account {
  id: string;
  status: IdentityStatus;
  version: number;
  createdAt: string;
  chainAccounts: ChainAccount[];
}

export interface Authority {
  id: string;
  type: "secp256r1";
  credentialId: string | null;
  /** 33-byte compressed secp256r1 public key, base64url — the on-chain authority. */
  publicKey: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type IntentType = "WITHDRAW_SOL" | "WITHDRAW_TOKEN";

export interface IntentPayload {
  amount: string;
  destination?: string;
  mint?: string;
  destinationAta?: string;
}

export interface Intent {
  id: string;
  type: IntentType;
  payload: IntentPayload & {
    chain: string;
    network: string;
    accountId: string;
    smartAccountAddress: string;
  };
  status: "pending" | "approved" | "executed" | "expired" | "rejected" | "cancelled";
  expiresAt: string;
  createdAt: string;
}

export interface IntentCreate {
  type: IntentType;
  payload: IntentPayload;
}

export interface WalletTransaction {
  id: string;
  intentId: string | null;
  chain: string;
  network: string;
  txHash: string | null;
  status: "prepared" | "submitted" | "confirmed" | "failed";
  createdAt: string;
}

/** WebAuthn registration ceremony (task 003). */
export interface RegisterStart {
  registrationId: string;
  options: Record<string, unknown>;
  isAdditional: boolean;
  approval: Record<string, unknown> | null;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
}
