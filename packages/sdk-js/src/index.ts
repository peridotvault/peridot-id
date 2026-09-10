import type {
  ApiError,
  AuthenticateStart,
  Authority,
  ExchangeResult,
  Identity,
  IdentityCredential,
  LoginResponse,
  Profile,
  ProfileUpdate,
  RegisterStart,
  Session,
  SsoGrant,
} from "@peridotvault/pid-types";
import { PeridotWallet, type PeridotWalletOptions } from "./wallet/wallet-client.js";
import { authenticatePasskey, registerPasskey, BrowserPasskeySigner, PasskeyHostedRequiredError } from "@peridotvault/pid-core";
import { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
import { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export { PeridotWallet, type PeridotWalletOptions };
export type { ActivationView, ActivationStatus } from "./wallet/wallet-client.js";
export { authenticatePasskey, BrowserPasskeySigner, PasskeyHostedRequiredError, registerPasskey } from "@peridotvault/pid-core";
export { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
export { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export interface PeridotOptions {
  baseUrl: string;
  /** Solana RPC endpoint (devnet/local) used for smart-account transactions. */
  solanaRpcUrl: string | string[];
  /** Fee-payer secure storage (defaults to an in-memory store). */
  feePayerStore?: SecretStore;
  /** On-chain activity cache (defaults to localStorage-backed). */
  historyStore?: HistoryStore;
  onUnauthorized?: () => void;
}

export class PeridotAuth {
  constructor(private client: PeridotClient) {}

  /**
   * Begin Google OAuth. Optional `returnTo` (an allowlisted cross-origin) redirects back
   * there with a one-time `pid_code` for SSO (see `exchange`). Pass `clientId` when
   * logging in on behalf of a registered third-party app (binds the code to the app).
   */
  async login(opts?: { returnTo?: string; clientId?: string }): Promise<void> {
    const body =
      opts?.returnTo || opts?.clientId
        ? { ...(opts.returnTo ? { returnTo: opts.returnTo } : {}), ...(opts.clientId ? { clientId: opts.clientId } : {}) }
        : undefined;
    const res = await this.client.post<LoginResponse>("/v1/auth/login", body);
    if (res.ok) window.location.assign((res.data as LoginResponse).url);
  }

  /**
   * Sign in with a discoverable passkey (WebAuthn get). With `returnTo`, the server issues
   * a one-time pid_code for SSO (see `exchange`). Resolves `{ ok: false }` ONLY when the
   * WebAuthn ceremony is cancelled by the user; genuine errors throw.
   */
  async loginWithPasskey(opts?: { returnTo?: string; clientId?: string }): Promise<{ ok: boolean; pidCode?: string }> {
    try {
      const finish = await authenticatePasskey({
        start: async () => {
          const res = await this.client.post<AuthenticateStart>("/v1/auth/passkey/start");
          if (!res.ok) throw new Error("Failed to start passkey login");
          return res.data as AuthenticateStart;
        },
        finish: async (input) => {
          const res = await this.client.post<{ ok: boolean; pidCode?: string }>("/v1/auth/passkey/finish", {
            ...input,
            ...(opts?.returnTo ? { returnTo: opts.returnTo } : {}),
            ...(opts?.clientId ? { clientId: opts.clientId } : {}),
          });
          if (!res.ok) throw new Error("Passkey sign-in failed");
          return res.data as { ok: boolean; pidCode?: string };
        },
      });
      return finish;
    } catch (e) {
      if (e instanceof Error && /cancelled/i.test(e.message)) return { ok: false };
      throw e;
    }
  }

  /**
   * Exchange a one-time SSO pid_code for the identity (for cross-origin relying parties).
   * `clientSecret` is backend-only (never ship it in frontend code) and required only
   * when the bound app has a secret set.
   */
  async exchange(code: string, clientId?: string, clientSecret?: string): Promise<ExchangeResult | ApiError> {
    const res = await this.client.post<ExchangeResult>("/v1/auth/exchange", {
      code,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    });
    return res.data;
  }

  /**
   * Mint a pid_code for the CURRENT session (cookie-authenticated, so same-site pages
   * only). Powers consent screens: an already-logged-in user approves an app without
   * re-authenticating. Throws on rejection (unknown app, disallowed returnTo).
   */
  async authorize(opts: { returnTo: string; clientId?: string }): Promise<{ pidCode: string }> {
    const res = await this.client.post<{ pidCode: string }>("/v1/auth/authorize", {
      returnTo: opts.returnTo,
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    });
    if (!res.ok) throw new Error("Authorization failed — returnTo is not allowed for this app.");
    return res.data as { pidCode: string };
  }

  async logout(): Promise<void> {
    await this.client.post("/v1/auth/logout");
  }

  async refresh(): Promise<true | "step-up" | false> {
    const res = await this.client.post("/v1/auth/refresh");
    if (res.ok) return true;
    const err = res.data as ApiError;
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "step_up_required") return "step-up";
    return false;
  }

  async sessions(): Promise<Session[] | ApiError> {
    const res = await this.client.get<Session[]>("/v1/auth/sessions");
    return res.data;
  }

  async revokeOtherSessions(): Promise<boolean> {
    const res = await this.client.delete("/v1/auth/sessions/revoke-others");
    return res.ok;
  }

  async revokeSession(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/auth/sessions/${id}`);
    return res.ok;
  }

  /** Third-party sites this identity signed in to (active grants, newest first). */
  async grants(): Promise<SsoGrant[] | ApiError> {
    const res = await this.client.get<SsoGrant[]>("/v1/auth/grants");
    return res.data;
  }

  /** Disconnect a site: stops future sign-ins there (the site's own session
   *  must still expire on its side). Idempotent. */
  async revokeGrant(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/auth/grants/${id}`);
    return res.ok;
  }
}

export class PeridotIdentity {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Identity | ApiError> {
    const res = await this.client.get<Identity>("/v1/identity/me");
    return res.data;
  }

  async credentials(): Promise<IdentityCredential[] | ApiError> {
    const res = await this.client.get<IdentityCredential[]>("/v1/identity/credentials");
    return res.data;
  }

  async unlinkCredential(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/identity/credentials/${id}`);
    return res.ok;
  }

  /** Soft-delete the Peridot ID (revokes all sessions). */
  async deleteAccount(): Promise<boolean> {
    const res = await this.client.delete("/v1/identity/me");
    return res.ok;
  }
}

export class PeridotProfile {
  constructor(private client: PeridotClient) {}

  async me(): Promise<Profile | ApiError> {
    const res = await this.client.get<Profile>("/v1/profile/me");
    return res.data;
  }

  async update(input: ProfileUpdate): Promise<Profile | ApiError> {
    const res = await this.client.patch<Profile>("/v1/profile", input);
    return res.data;
  }
}

/** Passkey credential management (task 003 ceremonies, wrapped for convenience). */
export class PeridotPasskey {
  constructor(private client: PeridotClient) {}

  async list(): Promise<Authority[] | ApiError> {
    const res = await this.client.get<Authority[]>("/v1/credentials");
    return res.data;
  }

  async register(): Promise<Authority> {
    return registerPasskey({
      registerStart: async () => {
        const res = await this.client.post<RegisterStart>("/v1/credentials/register/start");
        if (!res.ok) throw new Error("Failed to start passkey registration");
        return res.data as RegisterStart;
      },
      registerFinish: async (input) => {
        const res = await this.client.post<Authority>("/v1/credentials/register/finish", input);
        return res.data;
      },
    });
  }

  async revoke(id: string): Promise<Authority | ApiError> {
    const res = await this.client.delete<Authority>(`/v1/credentials/${id}`);
    return res.data;
  }
}

class PeridotClient {
  readonly auth: PeridotAuth;
  readonly identity: PeridotIdentity;
  readonly profile: PeridotProfile;
  readonly passkey: PeridotPasskey;
  readonly wallet: PeridotWallet;

  constructor(private baseUrl: string, walletOptions: PeridotWalletOptions, private onUnauthorized?: () => void) {
    this.auth = new PeridotAuth(this);
    this.identity = new PeridotIdentity(this);
    this.profile = new PeridotProfile(this);
    this.passkey = new PeridotPasskey(this);
    this.wallet = new PeridotWallet(this, walletOptions);
  }

  private async request<T>(path: string, init: RequestInit): Promise<{ ok: boolean; data: T | ApiError }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    if (res.status === 401) {
      if (!path.startsWith("/v1/auth/")) this.onUnauthorized?.();
      // Preserve a machine-readable reason (e.g. step_up_required) when present.
      let data: ApiError = { statusCode: 401, message: "Unauthorized" };
      try {
        const body = (await res.json()) as { message?: unknown; code?: unknown };
        if (body && typeof body === "object") {
          if (typeof body.message === "string" || Array.isArray(body.message)) data.message = body.message;
          if (typeof body.code === "string") data = { ...data, code: body.code };
        }
      } catch {
        // non-JSON 401 (gateway, proxy) — keep the generic shape
      }
      return { ok: false, data };
    }
    const data = res.status === 204 || !res.headers.get("content-type")?.includes("application/json")
      ? ({} as T)
      : await res.json();
    return { ok: res.ok, data };
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export { PeridotClient };
export type { ApiError, ExchangeResult };
export function Peridot(options: PeridotOptions): PeridotClient {
  return new PeridotClient(
    options.baseUrl,
    { solanaRpcUrl: options.solanaRpcUrl, feePayerStore: options.feePayerStore, historyStore: options.historyStore },
    options.onUnauthorized,
  );
}

export default Peridot;