export interface LoginResponse {
  url: string;
}

export interface Session {
  id: string;
  /** App namespace of a first-party app session (`dashboard`); null/absent = the wallet's. */
  scope?: string | null;
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
  isVerified: boolean;
  firstSeenAt: string;
  lastUsedAt: string;
}

/** Identity payload returned by `POST /v1/auth/exchange` for cross-origin SSO. */
export interface ExchangeResult {
  /** Permanent PID (`<handle>@pid`) — treat as opaque, render as-is. */
  pid: string;
  /** @deprecated one-release shim — identical to `pid`, removed next release. */
  identityId: string;
  profile: { displayName: string | null; avatarUrl: string | null };
  credentials: { provider: string; email: string | null }[];
  /** App-scoped bearer for the RP backend to read PeridotID APIs. Keep server-side. */
  accessToken: string;
  /** accessToken lifetime in seconds. */
  expiresIn: number;
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

/** Chain namespace an external wallet login can prove. */
export type WalletNamespace = "solana" | "evm";

/** Short-lived proof-of-ownership challenge for an external wallet. */
export interface WalletChallenge {
  challengeId: string;
  /** Exact UTF-8 message the wallet must sign. */
  message: string;
  expiresAt: string;
  namespace: WalletNamespace;
  /** Normalized address: EVM lowercase, Solana base58 verbatim. */
  address: string;
}

/** One external wallet linked as a login credential. */
export interface LinkedWallet {
  id: string;
  namespace: WalletNamespace;
  address: string;
  linkedAt: string;
  lastLoginAt: string | null;
}
