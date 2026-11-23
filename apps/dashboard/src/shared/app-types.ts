/** A PidApp as returned by the API (secrets are always omitted). */
export interface PidApp {
  id: string;
  clientId: string;
  name: string;
  /** Owner-set https logo shown on the sign-in consent screens. */
  logoUrl: string | null;
  /** Owner-set one-liner for the consent card (wallet clamps it to 2 lines). */
  description: string | null;
  allowedOrigins: string[];
  isActive: boolean;
  isVerified: boolean;
  clientSecretPrefix: string | null;
  clientSecretCreatedAt: string | null;
  webhookUrl: string | null;
  /** Enabled login methods (dashboard → Integrations). Missing = all on. */
  loginMethods?: string[];
}

/** One app page section. Lives in the URL (`?section=keys`) so the sidebar in
 *  WorkspaceLayout can own the nav and a section is deep-linkable. */
export type AppSection = "overview" | "users" | "xp" | "general" | "keys" | "fees" | "integrations";

/** `group` starts a new labelled group in the app sidebar. */
export const APP_SECTIONS: { key: AppSection; label: string; group?: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "users", label: "Users" },
  { key: "xp", label: "XP & Level" },
  { key: "general", label: "General", group: "Settings" },
  { key: "keys", label: "Keys" },
  { key: "fees", label: "Fees" },
  { key: "integrations", label: "Integrations" },
];

export function isAppSection(value: string | null): value is AppSection {
  return APP_SECTIONS.some((s) => s.key === value);
}

/** Provider catalogue row from GET /v1/providers (single source of truth). */
export interface ProviderMeta {
  code: string;
  name: string;
  imageUrl: string | null;
  category: "web2" | "web3";
  protocol: "oauth" | "email_otp" | "passkey" | "wallet_signature";
  isAvailable: boolean;
  adapter: string | null;
  isSupported: boolean;
  isConfigured: boolean;
}

/** Human label for a protocol — passkey/email are Web2 but not OAuth. */
export const PROTOCOL_LABEL: Record<ProviderMeta["protocol"], string> = {
  oauth: "OAuth",
  email_otp: "Email code",
  passkey: "Passkey (WebAuthn)",
  wallet_signature: "Wallet signature",
};

export const PROVIDER_GROUP_LABEL: Record<ProviderMeta["category"], string> = {
  web2: "Web2",
  web3: "Web3",
};

/** Per-app fee for one operation. */
export interface AppFee {
  operation: string;
  percentBps: number;
  minIdr: string;
  maxIdr: string;
  enabled: boolean;
}

/** One payment-gateway (DOKU) fee row (admin). `methodKey` is a DOKU method
 *  code, a category, or "*" (default). The list is the category catalog plus
 *  any stored extra keys. */
export interface PaymentFeeRate {
  methodKey: string;
  /** Display label (category name for catalog rows). */
  label: string;
  category: string | null;
  /** True for the fixed category catalog rows. */
  isCategory: boolean;
  percentBps: number;
  flatIdr: string;
  minIdr: string;
  maxIdr: string;
  enabled: boolean;
  updatedAt?: string | null;
}
