import type {
  AccountView,
  ApiError,
  AuthenticateStart,
  ExchangeResult,
  LoginResponse,
  Session,
  SsoGrant,
} from "@peridotvault/pid-types";
import { authenticatePasskey, PasskeyHostedRequiredError } from "@peridotvault/pid-core";
import { openLoginPopup, openLoginTab, PopupClosedError, PopupUnavailableError } from "./popup.js";
import type { PeridotClient } from "./client.js";

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
    const clientId = this.appId(opts?.clientId);
    const body =
      opts?.returnTo || clientId
        ? {
            ...(opts?.returnTo ? { returnTo: opts.returnTo } : {}),
            ...(clientId ? { clientId } : {}),
          }
        : undefined;
    const res = await this.client.post<LoginResponse>("/v1/auth/login", body);
    if (!res.ok) return null;
    return (res.data as LoginResponse).url;
  }

  /** App id from the call, else the client-level `clientId`. */
  private appId(explicit?: string): string | undefined {
    return explicit ?? this.client.clientId;
  }

  /** App secret from the call, else the client-level `clientSecret` (server-only). */
  private appSecret(explicit?: string): string | undefined {
    return explicit ?? this.client.clientSecret;
  }

  /**
   * Sign in via the PeridotID origin in a centered popup (Google + PID picker,
   * plus the PID claim step for new users). Resolves the one-time `pidCode` for
   * `exchange`. Uses the configured popup host — no URL to pass. Falls back to a
   * new tab when the popup is blocked. Throws `PopupUnavailableError` when no
   * host is configured.
   */
  async loginPopup(opts?: { clientId?: string; returnTo?: string; method?: string; firstParty?: boolean; sessionScope?: string }): Promise<{ pidCode?: string }> {
    return this.openLogin(openLoginPopup, opts);
  }

  /**
   * Sign in via the PeridotID origin in a new tab. Same result as `loginPopup`;
   * opt in when a tab is preferred over a popup.
   */
  async loginTab(opts?: { clientId?: string; returnTo?: string; method?: string; firstParty?: boolean; sessionScope?: string }): Promise<{ pidCode?: string }> {
    return this.openLogin(openLoginTab, opts);
  }

  /** Shared host guard + login popup params for {@link loginPopup}/{@link loginTab}. */
  private async openLogin(
    opener: (opts: { popupBaseUrl: string; params: Record<string, string | undefined> }) => Promise<{ pidCode?: string }>,
    opts?: { clientId?: string; returnTo?: string; method?: string; firstParty?: boolean; sessionScope?: string },
  ): Promise<{ pidCode?: string }> {
    if (!this.client.popupBaseUrl) {
      throw new PopupUnavailableError("No popup host configured — omit baseUrl so the env preset applies, or pass popupBaseUrl.");
    }
    if (typeof window === "undefined") throw new PopupUnavailableError("Sign-in needs a browser.");
    const clientId = this.appId(opts?.clientId);
    return opener({
      popupBaseUrl: this.client.popupBaseUrl,
      params: {
        popup: "login",
        origin: window.location.origin,
        ...(opts?.method ? { method: opts.method } : {}),
        ...(clientId ? { client_id: clientId } : {}),
        ...(opts?.returnTo ? { redirect_uri: opts.returnTo } : {}),
        ...(opts?.firstParty ? { first_party: "1" } : {}),
        ...(opts?.sessionScope ? { session_scope: opts.sessionScope } : {}),
      },
    });
  }

  /** Popup params shared by the login delegation below (redirect + app binding). */
  private loginPopupParams(opts?: { returnTo?: string; clientId?: string }): Record<string, string | undefined> {
    if (typeof window === "undefined") return {};
    const clientId = this.appId(opts?.clientId);
    return {
      redirect_uri: opts?.returnTo ?? window.location.origin,
      origin: window.location.origin,
      popup: "login",
      ...(clientId ? { client_id: clientId } : {}),
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
    const clientId = this.appId(opts?.clientId);
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
            ...(clientId ? { clientId } : {}),
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
   * Start email-OTP login: the server sends a 6-digit code (Brevo) to the
   * address. Always resolves true (never reveals whether the address has an
   * account); throws on rate limits or send failures.
   */
  async emailStart(email: string): Promise<boolean> {
    const res = await this.client.post<{ ok: boolean }>("/v1/auth/email/start", { email });
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Couldn't send the code"));
    }
    return true;
  }

  /**
   * Verify the 6-digit email code. Returning users get a session (plus a
   * one-time `pidCode` when `returnTo` is passed for SSO); new addresses get
   * `{ pendingClaim: true }` — call `claimStatus()` then `claim(handle)`.
   */
  async emailVerify(
    email: string,
    code: string,
    opts?: { returnTo?: string; clientId?: string },
  ): Promise<{ ok: boolean; pidCode?: string; pendingClaim?: boolean }> {
    const clientId = this.appId(opts?.clientId);
    const res = await this.client.post<{ ok: boolean; pidCode?: string; pendingClaim?: boolean }>(
      "/v1/auth/email/verify",
      {
        email,
        code,
        ...(opts?.returnTo ? { returnTo: opts.returnTo } : {}),
        ...(clientId ? { clientId } : {}),
      },
    );
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Email sign-in failed"));
    }
    return res.data as { ok: boolean; pidCode?: string; pendingClaim?: boolean };
  }

  /**
   * Exchange a one-time SSO pid_code for the identity (for cross-origin relying parties).
   * `redirectUri` is REQUIRED and must exactly equal the redirect target the code
   * was issued for (OAuth-style binding — the URL your app received the code on).
   * `clientSecret` is backend-only (never ship it in frontend code) and required only
   * when the bound app has a secret set.
   */
  async exchange(code: string, redirectUri: string, clientId?: string, clientSecret?: string): Promise<ExchangeResult | ApiError> {
    const cid = this.appId(clientId);
    const secret = this.appSecret(clientSecret);
    const res = await this.client.post<ExchangeResult>("/v1/auth/exchange", {
      code,
      redirectUri,
      ...(cid ? { clientId: cid } : {}),
      ...(secret ? { clientSecret: secret } : {}),
    });
    return res.data;
  }

  /**
   * Mint a pid_code for the CURRENT session (cookie-authenticated, so same-site pages
   * only). Powers consent screens: an already-logged-in user approves an app without
   * re-authenticating. Throws on rejection (unknown app, disallowed returnTo).
   */
  async authorize(opts: { returnTo: string; clientId?: string }): Promise<{ pidCode: string }> {
    const clientId = this.appId(opts.clientId);
    const res = await this.client.post<{ pidCode: string }>("/v1/auth/authorize", {
      returnTo: opts.returnTo,
      ...(clientId ? { clientId } : {}),
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

  /** Identities signed into this browser (wallet account switcher). */
  async accounts(): Promise<AccountView[] | ApiError> {
    const res = await this.client.get<AccountView[]>("/v1/auth/accounts");
    return res.data;
  }

  /** Make a linked identity active without re-authenticating. */
  async switchAccount(pid: string): Promise<boolean> {
    const res = await this.client.post("/v1/auth/accounts/switch", { pid });
    return res.ok;
  }

  /** Forget one identity in this browser (leaves the others signed in). */
  async signOutAccount(pid: string): Promise<boolean> {
    const res = await this.client.post("/v1/auth/accounts/signout", { pid });
    return res.ok;
  }

  /**
   * First-party login popup only: mint this app's own session
   * (`pid_access_<scope>`) from the current wallet session, so the app logs out
   * independently of the wallet.
   */
  async grantSession(scope: string): Promise<boolean> {
    const res = await this.client.post("/v1/auth/session/scope", { scope });
    return res.ok;
  }
}
