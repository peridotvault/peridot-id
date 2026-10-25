import type { ApiError } from "@peridotvault/pid-types";
import type { HistoryStore, PasskeySigner, SecretStore } from "@peridotvault/pid-core";
import { PeridotWallet, type PeridotWalletOptions } from "./wallet/wallet-client.js";
import { PeridotFiat } from "./fiat/fiat-client.js";
import { PeridotLevel } from "./level.js";
import { openPeridotPopup, PopupUnavailableError } from "./popup.js";
import { detectEnv, resolvePeridotUrls, warnOnLegacyHost, type PeridotEnv } from "./env.js";
import { PeridotAuth } from "./auth-client.js";
import { PeridotIdentity } from "./identity-client.js";
import { PeridotProfile } from "./profile-client.js";
import { PeridotPasskey } from "./passkey-client.js";
import { PeridotAdmin } from "./admin-client.js";

export interface PeridotOptions {
  /** Registered app id (`pidapp_…`). Applied to login, exchange, and fiat calls. */
  clientId?: string;
  /** Backend-only app secret (`pidsk_…`). NEVER ship in browser code — used by `auth.exchange`. */
  clientSecret?: string;
  /**
   * First-party client session namespace. Adds `x-pid-scope` to every request
   * so this app reads its own session cookies (`pid_access_<scope>`), separate
   * from the wallet's — logging out of either never logs out the other.
   */
  sessionScope?: string;
  /** Force the target environment (e.g. `sandbox` for a staging build). Default: NODE_ENV-derived. */
  env?: PeridotEnv;
  /** Advanced: API origin override (self-host/localhost). Defaults to the env preset. */
  baseUrl?: string;
  /** Advanced: popup host override. Preset from env unless `baseUrl` is passed. */
  popupBaseUrl?: string;
  /** Fee-payer secure storage (defaults to an in-memory store). */
  feePayerStore?: SecretStore;
  /**
   * Inline passkey signer — first-party PeridotID origin only. Omit on
   * third-party origins (with `popupBaseUrl` set): trust-critical methods then
   * delegate to the PeridotID popup instead of signing in the dev DOM.
   */
  passkeySigner?: PasskeySigner;
  /** On-chain activity cache (defaults to localStorage-backed). */
  historyStore?: HistoryStore;
  /**
   * Read-only bearer (`scope: "read"`) instead of session cookies. Used by
   * embedded wallet clients on a third-party origin, where the httpOnly
   * session cookies are cross-site and would be dropped by SameSite. Mutable
   * via {@link PeridotClient.setBearer} — an embed receives it after mount.
   */
  bearer?: string;
  onUnauthorized?: () => void;
}

export class PeridotClient {
  readonly auth: PeridotAuth;
  readonly identity: PeridotIdentity;
  readonly profile: PeridotProfile;
  readonly passkey: PeridotPasskey;
  readonly wallet: PeridotWallet;
  readonly fiat: PeridotFiat;
  readonly admin: PeridotAdmin;
  readonly level: PeridotLevel;

  private readonly appOptions: { clientId?: string; clientSecret?: string };

  constructor(
    private baseUrl: string,
    private walletOptions: PeridotWalletOptions,
    appOptions: { clientId?: string; clientSecret?: string } = {},
    private onUnauthorized?: () => void,
    private readonly sessionScope?: string,
    private bearer?: string,
  ) {
    this.appOptions = appOptions;
    this.auth = new PeridotAuth(this);
    this.identity = new PeridotIdentity(this);
    this.profile = new PeridotProfile(this);
    this.passkey = new PeridotPasskey(this);
    this.wallet = new PeridotWallet(this, walletOptions);
    this.fiat = new PeridotFiat(this, appOptions.clientId);
    this.admin = new PeridotAdmin(this);
    this.level = new PeridotLevel(this);
  }

  /** Registered app id applied by default (login/exchange/fiat). */
  get clientId(): string | undefined {
    return this.appOptions.clientId;
  }

  /** App secret applied by default (server-side `exchange` only). */
  get clientSecret(): string | undefined {
    return this.appOptions.clientSecret;
  }

  /**
   * Swap the read-only bearer (or clear it with `undefined`). The embedded
   * wallet calls this once the parent hands over the exchanged token, so the
   * client authenticates reads without cross-site cookies.
   */
  setBearer(token?: string): void {
    this.bearer = token;
  }

  private async request<T>(path: string, init: RequestInit & { multipart?: boolean }): Promise<{ ok: boolean; data: T | ApiError }> {
    const { multipart, ...fetchInit } = init;
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...fetchInit,
      credentials: this.bearer ? "omit" : "include",
      headers: {
        ...(multipart ? {} : { "Content-Type": "application/json" }),
        ...(this.sessionScope ? { "x-pid-scope": this.sessionScope } : {}),
        ...(this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {}),
        ...fetchInit.headers,
      },
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

  /** Multipart POST (logo upload) — fetch sets the boundary, so no JSON header. */
  postForm<T>(path: string, form: FormData) {
    return this.request<T>(path, { method: "POST", body: form, multipart: true } as RequestInit & { multipart?: boolean });
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
   * Sandbox MVP (FR-4): startup environment check against GET /v1/env.
   * Compares the server-derived `env` with the SDK's configured env (from
   * `Peridot({ env })` or `detectEnv()`). Resolves `ok:true` on match, or
   * `ok:false` with both sides on mismatch so the caller can warn/abort
   * before moving money ("never point a sandbox build at prod" footgun).
   * Returns `ok:true, checked:false` when the endpoint is absent (pre-FR-1
   * backend) — never throws for a missing route.
   */
  async checkEnv(expectedEnv?: PeridotEnv): Promise<
    | { ok: true; env: string; checked: boolean }
    | { ok: false; expected: string; actual: string }
  > {
    const expected = expectedEnv ?? detectEnv();
    let actual: string;
    try {
      const res = await this.get<{ env: string }>("/v1/env");
      if (!res.ok) return { ok: true, env: expected, checked: false };
      actual = (res.data as { env: string }).env;
    } catch {
      return { ok: true, env: expected, checked: false };
    }
    if (actual !== expected) return { ok: false, expected, actual };
    return { ok: true, env: actual, checked: true };
  }

  /**
   * Run one trust-critical action inside the PeridotID popup (handshake flow).
   * Pass `expectedPid` (the dapp's connected pid) so the popup approves as
   * that exact account: it auto-switches when the pid is signed in this
   * browser and refuses otherwise, instead of signing as the wallet tab's
   * active account. The result echoes it back as `approvedPid` — verify it.
   * Throws PopupUnavailableError without a popupBaseUrl or off-browser.
   */
  async popupRequest<T>(action: string, payload?: unknown, opts?: { expectedPid?: string }): Promise<T> {
    if (!this.popupBaseUrl) {
      throw new PopupUnavailableError(
        `Cannot ${action} here — pass popupBaseUrl to delegate to the PeridotID popup, or passkeySigner for first-party inline use.`,
      );
    }
    const expectedPid = opts?.expectedPid || undefined;
    return openPeridotPopup<T>({
      popupBaseUrl: this.popupBaseUrl,
      params: { popup: action, ...(expectedPid ? { expected_pid: expectedPid } : {}) },
      request: { action, payload, ...(expectedPid ? { expectedPid } : {}) },
    });
  }
}

export function Peridot(options: PeridotOptions = {}): PeridotClient {
  const preset = resolvePeridotUrls(options.env);
  // Caller-supplied baseUrl means "I know where the API is" (self-host/localhost) —
  // then the popup host is theirs to pass too; otherwise the env preset fills both.
  const popupBaseUrl = options.popupBaseUrl ?? (options.baseUrl ? undefined : preset.popupBaseUrl);
  warnOnLegacyHost(options.baseUrl);
  warnOnLegacyHost(options.popupBaseUrl);
  return new PeridotClient(
    options.baseUrl ?? preset.baseUrl,
    {
      feePayerStore: options.feePayerStore,
      passkeySigner: options.passkeySigner,
      popupBaseUrl,
      historyStore: options.historyStore,
    },
    { clientId: options.clientId, clientSecret: options.clientSecret },
    options.onUnauthorized,
    options.sessionScope,
    options.bearer,
  );
}
