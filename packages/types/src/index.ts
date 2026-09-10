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
  status: "inactivated" | "funded" | "ready" | "activating" | "active" | "insufficient";
  activationBalance: number | null;
  activationRequired: number | null;
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
  type: "DEPOSIT" | "WITHDRAW" | "ACTIVATION" | null;
  amount: string | null;
  asset: string | null;
  direction: "in" | "out" | null;
  counterparty: string | null;
  chain: string;
  network: string;
  txHash: string | null;
  status: "prepared" | "submitted" | "confirmed" | "failed";
  createdAt: string;
  confirmedAt: string | null;
}

export interface ActivityRecord {
  type: "DEPOSIT" | "WITHDRAW" | "ACTIVATION";
  amount: string;
  asset: string;
  direction: "in" | "out";
  counterparty?: string;
  txHash?: string;
}

export interface Session {
  id: string;
  userAgent: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent?: boolean;
}

/** Third-party site the identity signed in to ("App connections"). Revoking
 *  stops future sign-ins there; it cannot end the site's own session. */
export interface SsoGrant {
  id: string;
  origin: string;
  clientId: string | null;
  name: string | null;
  firstSeenAt: string;
  lastUsedAt: string;
}

/** Identity payload returned by `POST /v1/auth/exchange` for cross-origin SSO. */
export interface ExchangeResult {
  identityId: string;
  profile: { displayName: string | null; avatarUrl: string | null };
  credentials: { provider: string; email: string | null }[];
}

/** WebAuthn registration ceremony (task 003). */
export interface RegisterStart {
  registrationId: string;
  options: Record<string, unknown>;
  isAdditional: boolean;
  approval: Record<string, unknown> | null;
}

/** WebAuthn authentication ceremony start (passkey login). */
export interface AuthenticateStart {
  authenticationId: string;
  options: Record<string, unknown>;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  /** Machine-readable reason (e.g. "step_up_required") when the server sends one. */
  code?: string;
}
