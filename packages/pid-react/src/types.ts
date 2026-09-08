import type { ReactNode } from "react";
import type { ExchangeResult, PeridotClient } from "@peridotvault/pid-sdk-js";

/** Login methods offered in the modal. Data-driven so future methods slot in. */
export type LoginMethod = "google" | "passkey";

export interface PeridotProviderProps {
  children: ReactNode;
  /** PeridotID API base URL. Defaults to production — most apps never set this. */
  baseUrl?: string;
  /** Your app's public client_id from `POST /v1/apps` (binds pid_codes to your app). */
  clientId?: string;
  /** Where PeridotID returns with `?pid_code=`. Defaults to the current origin. */
  redirectUri?: string;
  solanaRpcUrl?: string | string[];
  methods?: LoginMethod[];
  /**
   * Called with the one-time pid_code after login. Default exchanges it directly
   * against the PeridotID API (pure-frontend apps). Pass your own to exchange via
   * your backend (which then mints your app's session).
   */
  onExchange?: (code: string) => Promise<void>;
  onSuccess?: (identity: ExchangeResult | null) => void;
  onError?: (err: unknown) => void;
}

export interface UsePeridotApi {
  /** Last exchanged PeridotID identity (null until a login completes). */
  user: ExchangeResult | null;
  loading: boolean;
  error: string | null;
  /** Open the login modal (chooses Google / passkey / …). */
  openLogin: () => void;
  closeLogin: () => void;
  logout: () => Promise<void>;
  /** Raw SDK client for advanced use (wallet, profile, …). */
  client: PeridotClient;
}
