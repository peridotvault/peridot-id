import type {
  ApiError,
  AuthenticateStart,
  Authority,
  Chain,
  ChainContract,
  CreateChainInput,
  ExchangeResult,
  Identity,
  IdentityCredential,
  LoginResponse,
  Profile,
  ProfileUpdate,
  RegisterStart,
  Role,
  Session,
  SsoGrant,
  UpdateChainInput,
  UpsertContractInput,
} from "@peridotvault/pid-types";
import { PeridotWallet, type PeridotWalletOptions } from "./wallet/wallet-client.js";
import { PeridotFiat } from "./fiat/fiat-client.js";
import { authenticatePasskey, registerPasskey, BrowserPasskeySigner, PasskeyHostedRequiredError } from "@peridotvault/pid-core";
import type { PasskeySigner } from "@peridotvault/pid-core";
import { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
import { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";
import { openLoginPopup, openPeridotPopup } from "./popup.js";
import { PopupClosedError, PopupUnavailableError } from "./popup.js";

export { PeridotWallet, type PeridotWalletOptions };
export type { ExecuteInput, ExecuteMetaInput, RotateInput, TopupInput, WithdrawInput } from "./wallet/wallet-client.js";
export {
  PeridotFiat,
  type CheckoutDepositView,
  type FeePolicyView,
  type FiatBalanceView,
  type FiatDepositView,
  type FiatLedgerEntry,
  type FiatLedgerView,
  type FiatTransferInput,
  type FiatTransferInquiryView,
} from "./fiat/fiat-client.js";
export type { ActivationView, ActivationStatus } from "./wallet/wallet-client.js";
export { authenticatePasskey, BrowserPasskeySigner, PasskeyHostedRequiredError, registerPasskey } from "@peridotvault/pid-core";
export type { PasskeySigner } from "@peridotvault/pid-core";
export {
  awaitPopupRequest,
  forwardPopupLoginCode,
  openLoginPopup,
  openLoginTab,
  openPeridotPopup,
  parsePopupOrigin,
  postPopupReady,
  postPopupResult,
  readPopupParams,
  PopupBlockedError,
  PopupClosedError,
  PopupUnavailableError,
} from "./popup.js";
export type { PopupParams, PopupResult } from "./popup.js";
export { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
export { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export interface PeridotOptions {
  baseUrl: string;
  /** Solana RPC endpoint (devnet/local) used for smart-account transactions. */
  solanaRpcUrl: string | string[];
  /** Fee-payer secure storage (defaults to an in-memory store). */
  feePayerStore?: SecretStore;
  /**
   * Inline passkey signer — first-party PeridotID origin only. Omit on
   * third-party origins (with `popupBaseUrl` set): trust-critical methods then
   * delegate to the PeridotID popup instead of signing in the dev DOM.
   */
  passkeySigner?: PasskeySigner;
  /** Popup host for delegated ceremonies, e.g. https://app.pid.peridotvault.com (no prod default). */
  popupBaseUrl?: string;
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
   * New credentials land on the PID picker (claim flow) — handles are only ever
   * chosen there, never up front.
   * Resolves the Google login URL (the caller navigates — headless client never
   * navigates itself), or null when the login URL could not be obtained.
   */
  async login(opts?: { returnTo?: string; clientId?: string }): Promise<string | null> {
    const body =
      opts?.returnTo || opts?.clientId
        ? {
            ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
            ...(opts.clientId ? { clientId: opts.clientId } : {}),
          }
        : undefined;
    const res = await this.client.post<LoginResponse>("/v1/auth/login", body);
    if (!res.ok) return null;
    return (res.data as LoginResponse).url;
  }

  /** Popup params shared by the login delegation below (redirect + app binding). */
  private loginPopupParams(opts?: { returnTo?: string; clientId?: string }): Record<string, string | undefined> {
    if (typeof window === "undefined") return {};
    return {
      redirect_uri: opts?.returnTo ?? window.location.origin,
      origin: window.location.origin,
      popup: "login",
      ...(opts?.clientId ? { client_id: opts.clientId } : {}),
    };
  }

  /** Popup login result mapped onto the inline `{ ok, pidCode }` shape. */
  private async loginViaPopup(
    opts?: { returnTo?: string; clientId?: string },
    extra?: Record<string, string | undefined>,
  ): Promise<{ ok: boolean; pidCode?: string }> {
    if (!this.client.popupBaseUrl) throw new PopupUnavailableError("Passkey sign-in needs the PeridotID origin — pass popupBaseUrl or run on it.");
    try {
      const data = await openLoginPopup({
        popupBaseUrl: this.client.popupBaseUrl,
        params: { ...this.loginPopupParams(opts), ...extra },
      });
      return { ok: true, pidCode: data.pidCode };
    } catch (e) {
      // User said no (deny / close) ≈ inline cancel: resolve, don't throw.
      if (e instanceof PopupClosedError || (e instanceof Error && /denied|cancelled|closed|rejected/i.test(e.message))) {
        return { ok: false };
      }
      throw e;
    }
  }

  /**
   * Sign in with a discoverable passkey (WebAuthn get). With `returnTo`, the server issues
   * a one-time pid_code for SSO (see `exchange`). Resolves `{ ok: false }` ONLY when the
   * WebAuthn ceremony is cancelled by the user; genuine errors throw.
   * On a foreign origin the ceremony cannot legally run here (rpId law) — it
   * delegates to the PeridotID popup instead of failing cryptically.
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
      if (e instanceof PasskeyHostedRequiredError && this.client.popupBaseUrl) {
        return this.loginViaPopup(opts, { method: "passkey" });
      }
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

  /** Check whether a PID handle is free (`ifal` → `ifal@pid`). */
  async pidAvailable(handle: string): Promise<{ available: boolean; pid: string | null }> {
    const res = await this.client.get<{ available: boolean; pid: string | null }>(
      `/v1/auth/pid/available?handle=${encodeURIComponent(handle)}`,
    );
    return res.data as { available: boolean; pid: string | null };
  }

  /**
   * Pending post-auth PID claim (if any): a verified credential with no identity
   * yet. The claim UI shows this, then calls `claim(handle)`.
   */
  async claimStatus(): Promise<
    | { pending: true; email: string | null; displayName: string | null; avatarUrl: string | null }
    | { pending: false }
  > {
    const res = await this.client.get("/v1/auth/claim/status");
    return res.data as { pending: boolean; email: string | null; displayName: string | null; avatarUrl: string | null };
  }

  /**
   * Claim the pending credential under a fresh permanent handle. Issues the
   * session on success. When the claim came from a relying-party login, the
   * result also carries the SSO `pidCode` plus the validated `redirectTo` —
   * the caller (a hosted page) navigates there itself.
   */
  async claim(handle: string): Promise<{ ok: boolean; pid: string; pidCode?: string; redirectTo?: string }> {
    const res = await this.client.post<{ ok: boolean; pid: string; pidCode?: string; redirectTo?: string }>(
      "/v1/auth/claim",
      { handle },
    );
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Claim failed"));
    }
    return res.data as { ok: boolean; pid: string; pidCode?: string; redirectTo?: string };
  }

  /**
   * Abandon a pending PID claim (back to the login screen). Consumes the ticket
   * so it can never be picked up later; always succeeds, even with no ticket.
   */
  async cancelClaim(): Promise<boolean> {
    const res = await this.client.delete("/v1/auth/claim");
    return res.ok;
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
    try {
      return await registerPasskey({
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
    } catch (e) {
      if (e instanceof PasskeyHostedRequiredError) {
        return this.client.popupRequest<Authority>("register");
      }
      throw e;
    }
  }

  async revoke(id: string): Promise<Authority | ApiError> {
    const res = await this.client.delete<Authority>(`/v1/credentials/${id}`);
    return res.data;
  }
}

/** Admin chain-registry management (role-gated server-side; hidden in UI for users). */
export class PeridotAdmin {
  constructor(private client: PeridotClient) {}

  async chains(): Promise<Chain[] | ApiError> {
    const res = await this.client.get<Chain[]>("/v1/admin/chains");
    return res.data;
  }

  async createChain(input: CreateChainInput): Promise<Chain | ApiError> {
    const res = await this.client.post<Chain>("/v1/admin/chains", input);
    return res.data;
  }

  async updateChain(id: string, input: UpdateChainInput): Promise<Chain | ApiError> {
    const res = await this.client.patch<Chain>(`/v1/admin/chains/${id}`, input);
    return res.data;
  }

  async upsertContract(chainId: string, input: UpsertContractInput): Promise<ChainContract | ApiError> {
    const res = await this.client.post<ChainContract>(`/v1/admin/chains/${chainId}/contracts`, input);
    return res.data;
  }
}

class PeridotClient {
  readonly auth: PeridotAuth;
  readonly identity: PeridotIdentity;
  readonly profile: PeridotProfile;
  readonly passkey: PeridotPasskey;
  readonly wallet: PeridotWallet;
  readonly fiat: PeridotFiat;
  readonly admin: PeridotAdmin;

  constructor(
    private baseUrl: string,
    private walletOptions: PeridotWalletOptions,
    private onUnauthorized?: () => void,
  ) {
    this.auth = new PeridotAuth(this);
    this.identity = new PeridotIdentity(this);
    this.profile = new PeridotProfile(this);
    this.passkey = new PeridotPasskey(this);
    this.wallet = new PeridotWallet(this, walletOptions);
    this.fiat = new PeridotFiat(this);
    this.admin = new PeridotAdmin(this);
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

  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }

  /** Popup host for delegated trust-critical actions (absent = first-party inline mode). */
  get popupBaseUrl(): string | undefined {
    return this.walletOptions.popupBaseUrl;
  }

  /**
   * Run one trust-critical action inside the PeridotID popup (handshake flow).
   * Throws PopupUnavailableError without a popupBaseUrl or off-browser.
   */
  async popupRequest<T>(action: string, payload?: unknown): Promise<T> {
    if (!this.popupBaseUrl) {
      throw new PopupUnavailableError(
        `Cannot ${action} here — pass popupBaseUrl to delegate to the PeridotID popup, or passkeySigner for first-party inline use.`,
      );
    }
    return openPeridotPopup<T>({ popupBaseUrl: this.popupBaseUrl, params: { popup: action }, request: { action, payload } });
  }
}

export { PeridotClient };
export type {
  ApiError,
  Authority,
  Chain,
  ChainContract,
  CreateChainInput,
  ExchangeResult,
  Identity,
  IdentityCredential,
  Profile,
  ProfileUpdate,
  Role,
  Session,
  SsoGrant,
  UpdateChainInput,
  UpsertContractInput,
};
export function Peridot(options: PeridotOptions): PeridotClient {
  return new PeridotClient(
    options.baseUrl,
    {
      solanaRpcUrl: options.solanaRpcUrl,
      feePayerStore: options.feePayerStore,
      passkeySigner: options.passkeySigner,
      popupBaseUrl: options.popupBaseUrl,
      historyStore: options.historyStore,
    },
    options.onUnauthorized,
  );
}

export default Peridot;