// Runtime adapter registry. The database stores catalogue metadata and OAuth
// client credentials, never executable adapter names or endpoints — a provider
// can only become available when an adapter here implements its protocol.
//
// OAuth endpoints are code-owned constants (official provider documentation),
// never admin input, so a dashboard edit cannot point the server at an
// arbitrary URL (SSRF). `implemented: false` entries document the intended
// contract but cannot authenticate and cannot be enabled.

import { resolveServiceUrls } from "../common/app-config";

export type ProviderProtocol = "oauth" | "email_otp" | "passkey" | "wallet_signature";

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  /** Default scopes when the admin has not set any. */
  scopes: string[];
}

export interface ProviderAdapter {
  /** Stable adapter id shown in the admin catalogue. */
  adapter: string;
  protocols: ProviderProtocol[];
  /** False = catalogue-only; cannot be enabled or used to log in. */
  implemented: boolean;
  oauth?: OAuthEndpoints;
  /** Wallet connector namespace this adapter implements (never inferred). */
  namespace?: "solana" | "evm";
}

export const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  google: {
    adapter: "google-oauth2",
    protocols: ["oauth"],
    implemented: true,
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
    },
  },
  discord: {
    adapter: "discord-oauth2",
    protocols: ["oauth"],
    implemented: false,
    oauth: {
      authorizeUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      userInfoUrl: "https://discord.com/api/users/@me",
      scopes: ["identify", "email"],
    },
  },
  github: {
    adapter: "github-oauth2",
    protocols: ["oauth"],
    implemented: false,
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
    },
  },
  email: { adapter: "email-otp", protocols: ["email_otp"], implemented: true },
  passkey: { adapter: "webauthn", protocols: ["passkey"], implemented: true },
  phantom: { adapter: "solana-injected", protocols: ["wallet_signature"], implemented: true, namespace: "solana" },
  metamask: { adapter: "evm-injected", protocols: ["wallet_signature"], implemented: true, namespace: "evm" },
};

export function adapterFor(code: string): ProviderAdapter | null {
  return PROVIDER_ADAPTERS[code] ?? null;
}

/** An adapter exists AND ships a runtime for this protocol. */
export function adapterSupports(code: string, protocol: string): boolean {
  const entry = adapterFor(code);
  return Boolean(entry?.implemented && entry.protocols.includes(protocol as ProviderProtocol));
}

/** Server-derived callback URL; the admin copies it into the provider console. */
export function oauthRedirectUri(apiUrl: string, code: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/auth/oauth/${encodeURIComponent(code)}/callback`;
}

export function apiUrlFrom(get: (key: string, def?: string) => unknown): string {
  return resolveServiceUrls(get).apiUrl;
}
