import type {
  AccountView,
  ApiError,
  AuthenticateStart,
  ExchangeResult,
  LinkedWallet,
  LoginResponse,
  RpRefreshResult,
  Session,
  SsoGrant,
  WalletChallenge,
  WalletNamespace,
} from "@peridotvault/pid-types";
import { authenticatePasskey, PasskeyHostedRequiredError } from "@peridotvault/pid-core";
import { openLoginPopup, openLoginTab, PopupClosedError, PopupUnavailableError } from "./popup.js";
import type { PeridotClient } from "./client.js";
import { CACHE_TTL, cachedRead, clearCache, invalidateCache } from "./internal/cache.js";

/** Options accepted by the hosted login entry points ({@link loginPopup}/{@link loginTab}). */
export interface LoginHostOpts {
  clientId?: string;
  returnTo?: string;
  method?: string;
  firstParty?: boolean;
  sessionScope?: string;
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
    // The round-trip may land a different identity: never serve cached reads
    // (identity/profile/balance) from the account that was active before.
    clearCache();
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
   * Sign in via the PeridotID origin in a new tab (Google + PID picker, plus the
   * PID claim step for new users). Resolves the one-time `pidCode` for
   * `exchange`. Identical to {@link loginTab} — kept for API compatibility.
   *
   * @deprecated use `loginTab`. Login no longer opens a popup: extension
   * wallets (MetaMask) create their own window parented to the requesting one,
   * and a script-opened popup parent crashes Brave's browser process.
   */
  async loginPopup(opts?: LoginHostOpts): Promise<{ pidCode?: string }> {
    return this.openLogin(openLoginPopup, opts);
  }

  /**
   * Sign in via the PeridotID origin in a new tab. Same result as `loginPopup`;
   * opt in when a tab is preferred over a popup.
   */
  async loginTab(opts?: LoginHostOpts): Promise<{ pidCode?: string }> {
    return this.openLogin(openLoginTab, opts);
  }

  /** Shared host guard + login params for {@link loginPopup}/{@link loginTab}. */
  private async openLogin(
    opener: (opts: { popupBaseUrl: string; params: Record<string, string | undefined> }) => Promise<{ pidCode?: string }>,
    opts?: LoginHostOpts,
  ): Promise<{ pidCode?: string }> {
    // Same rule as login(): the popup may sign in as another account.
    clearCache();
    if (!this.client.popupBaseUrl) {
      throw new PopupUnavailableError("No popup host configured — omit baseUrl so the env preset applies, or pass popupBaseUrl.");
    }
    if (typeof window === "undefined") throw new PopupUnavailableError("Sign-in needs a browser.");
    return opener({ popupBaseUrl: this.client.popupBaseUrl, params: this.loginParams(opts) });
  }

  /**
   * The one login params builder: hosted URL `?popup=login&origin=&client_id=`.
   * `redirect_uri` always points somewhere real (the caller's `returnTo`, else
   * this origin) so the hosted page can mint a code even when its opener is
   * gone — the tab simply lands back on the app instead of stranding.
   */
  private loginParams(opts?: LoginHostOpts): Record<string, string | undefined> {
    if (typeof window === "undefined") return {};
    const clientId = this.appId(opts?.clientId);
    return {
      popup: "login",
      origin: window.location.origin,
      redirect_uri: opts?.returnTo ?? window.location.origin,
      ...(opts?.method ? { method: opts.method } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(opts?.firstParty ? { first_party: "1" } : {}),
      ...(opts?.sessionScope ? { session_scope: opts.sessionScope } : {}),
      // One wallet host serves both networks: tell it which API to use.
      env: this.client.networkMode(),
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
        params: { ...this.loginParams(opts), ...extra },
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
    clearCache();
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
   * Start external-wallet login (Phantom/Solana, MetaMask/EVM). Returns the
   * exact message the wallet must sign — the server verifies the signature
   * against the address, so nothing here trusts a client claim. Proof of
   * ownership only: no funds move and no spending is approved.
   */
  async walletChallenge(input: {
    providerCode?: "phantom" | "metamask";
    namespace: WalletNamespace;
    reference: string;
    address: string;
    /** Cross-origin app target: the verified login then returns a `pidCode`. */
    returnTo?: string;
    clientId?: string;
    /** PKCE S256 challenge — required by public clients. */
    codeChallenge?: string;
  }): Promise<WalletChallenge> {
    const clientId = this.appId(input.clientId);
    const res = await this.client.post<WalletChallenge>("/v1/auth/wallet/challenge", {
      // Server-side record of which wallet answered — the only way to tell
      // MetaMask from Brave Wallet/Phantom after the fact (crash forensics).
      ...(input.providerCode ? { providerCode: input.providerCode } : {}),
      namespace: input.namespace,
      reference: input.reference,
      address: input.address,
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      ...(clientId ? { clientId } : {}),
      ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
    });
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Couldn't start wallet sign-in"));
    }
    return res.data as WalletChallenge;
  }

  /**
   * Finish external-wallet login with the wallet's signature over the issued
   * message (base64 for Solana, hex for EVM). A returning wallet gets a session
   * (`pid`); an unknown wallet gets `{ pendingClaim: true }` — then
   * `claimStatus()` → `claim(handle)`.
   */
  async walletVerify(
    challengeId: string,
    signature: string,
  ): Promise<{ ok: boolean; pid?: string; pidCode?: string; pendingClaim?: boolean; claimTicket?: string }> {
    const res = await this.client.post<{
      ok: boolean;
      pid?: string;
      pidCode?: string;
      pendingClaim?: boolean;
      claimTicket?: string;
    }>("/v1/auth/wallet/verify", { challengeId, signature });
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Wallet sign-in failed"));
    }
    clearCache();
    return res.data as {
      ok: boolean;
      pid?: string;
      pidCode?: string;
      pendingClaim?: boolean;
      claimTicket?: string;
    };
  }

  /** Start linking an external wallet to the CURRENT session's PID. */
  async walletLinkChallenge(input: {
    providerCode?: "phantom" | "metamask";
    namespace: WalletNamespace;
    reference: string;
    address: string;
  }): Promise<WalletChallenge> {
    const res = await this.client.post<WalletChallenge>("/v1/auth/wallet/link/challenge", input);
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Couldn't start wallet linking"));
    }
    return res.data as WalletChallenge;
  }

  /** Attach the proven wallet to this PID. Throws when the address belongs to another PID. */
  async walletLink(challengeId: string, signature: string): Promise<LinkedWallet> {
    const res = await this.client.post<LinkedWallet>("/v1/auth/wallet/link", { challengeId, signature });
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Wallet linking failed"));
    }
    invalidateCache("identity.");
    return res.data as LinkedWallet;
  }

  /** External wallets linked as login credentials for this PID. */
  async wallets(): Promise<LinkedWallet[] | ApiError> {
    return cachedRead("auth.wallets", CACHE_TTL.auth, async () => {
      const res = await this.client.get<LinkedWallet[]>("/v1/auth/wallet");
      return res.data;
    });
  }

  /** Unlink a wallet. The server refuses to remove the last login method. */
  async unlinkWallet(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/auth/wallet/${id}`);
    if (res.ok) invalidateCache("auth.");
    return res.ok;
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
    clearCache();
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
   * Rotate the RP backend session (server-side only — never call this in the
   * browser). Post the `refreshToken` from `exchange` before it expires; you get
   * a fresh bearer + a rotated refresh token. Store the new one, discard the old.
   */
  async refreshRp(refreshToken: string): Promise<RpRefreshResult | ApiError> {
    const res = await this.client.post<RpRefreshResult>("/v1/auth/rp/refresh", { refreshToken });
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
    // A bearer session (relying party / embed) owns NO cookie on the API host.
    // Posting an unscoped logout from there would clear the FIRST-PARTY wallet
    // cookies (`pid_access`/`pid_refresh`) and sign the user out of PeridotID
    // itself — so that sign-out stays local.
    if (this.client.hasBearer && !this.client.sessionScope) {
      this.client.setBearer(undefined);
      clearCache();
      return;
    }
    await this.client.post("/v1/auth/logout");
    clearCache();
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
  async claim(
    handle: string,
    /** Ticket from a cross-origin wallet login (`claimTicket`); cookie callers omit it. */
    ticket?: string,
  ): Promise<{ ok: boolean; pid: string; pidCode?: string; redirectTo?: string }> {
    const res = await this.client.post<{ ok: boolean; pid: string; pidCode?: string; redirectTo?: string }>(
      "/v1/auth/claim",
      { handle, ...(ticket ? { ticket } : {}) },
    );
    if (!res.ok) {
      const msg = (res.data as ApiError)?.message;
      throw new Error(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Claim failed"));
    }
    clearCache();
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
    return cachedRead("auth.sessions", CACHE_TTL.auth, async () => {
      const res = await this.client.get<Session[]>("/v1/auth/sessions");
      return res.data;
    });
  }

  async revokeOtherSessions(): Promise<boolean> {
    const res = await this.client.delete("/v1/auth/sessions/revoke-others");
    if (res.ok) invalidateCache("auth.");
    return res.ok;
  }

  async revokeSession(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/auth/sessions/${id}`);
    if (res.ok) invalidateCache("auth.");
    return res.ok;
  }

  /** Third-party sites this identity signed in to (active grants, newest first). */
  async grants(): Promise<SsoGrant[] | ApiError> {
    return cachedRead("auth.grants", CACHE_TTL.auth, async () => {
      const res = await this.client.get<SsoGrant[]>("/v1/auth/grants");
      return res.data;
    });
  }

  /** Disconnect a site: stops future sign-ins there (the site's own session
   *  must still expire on its side). Idempotent. */
  async revokeGrant(id: string): Promise<boolean> {
    const res = await this.client.delete(`/v1/auth/grants/${id}`);
    if (res.ok) invalidateCache("auth.");
    return res.ok;
  }

  /** Identities signed into this browser (wallet account switcher). */
  async accounts(): Promise<AccountView[] | ApiError> {
    return cachedRead("auth.accounts", CACHE_TTL.auth, async () => {
      const res = await this.client.get<AccountView[]>("/v1/auth/accounts");
      return res.data;
    });
  }

  /** Make a linked identity active without re-authenticating. */
  async switchAccount(pid: string): Promise<boolean> {
    const res = await this.client.post("/v1/auth/accounts/switch", { pid });
    // Another identity is active now: every cached read belongs to the old one.
    if (res.ok) clearCache();
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
