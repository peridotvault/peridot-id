import { ExecutionContext, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";
import { setOAuthStateCookie } from "../common/cookies";
import { decodeState } from "./sso.service";
import { newOAuthNonce, oauthStateSecret, signOAuthState } from "./oauth-state";
import { GOOGLE_OAUTH_OPTIONS, GoogleOAuthOptions } from "./google.strategy";
import { resolveServiceUrls } from "../common/app-config";

/** Marker for a failed OAuth callback — the controller redirects to retry UI. */
export interface GoogleAuthError {
  authError: string;
}

export function isGoogleAuthError(user: unknown): user is GoogleAuthError {
  return typeof user === "object" && user !== null && "authError" in user;
}

/** Never leak provider internals to the browser — one opaque code, details in server logs. */
function toErrorCode(err: unknown): string {
  if (err instanceof ServiceUnavailableException) return "oauth_not_configured";
  return "oauth_failed";
}

@Injectable()
export class GoogleGuard extends AuthGuard("google") {
  private readonly logger = new Logger(GoogleGuard.name);
  private readonly configured: boolean;

  constructor(
    @Inject(GOOGLE_OAUTH_OPTIONS) oauthOptions: GoogleOAuthOptions | null,
    private readonly config: ConfigService,
  ) {
    super();
    this.configured = Boolean(oauthOptions);
  }

  canActivate(context: ExecutionContext) {
    if (!this.configured) {
      throw new ServiceUnavailableException("Google OAuth is not configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (and API_URL for the derived callback) in the env for this environment");
    }
    return super.canActivate(context) as boolean;
  }

  /**
   * Strategy/transport failure (stale code, exchange error, DB outage) becomes a
   * retryable marker instead of Nest's raw 500 JSON — the controller redirects to
   * the wallet with `?error=<code>`. Cause stays in server logs only.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest(err: any, user: any, _info?: any, _context?: any): any {
    if (err || !user) {
      const code = toErrorCode(err);
      // Log the provider cause server-side (codes alone made sandbox triage
      // blind) — the browser still only ever sees the opaque code.
      const cause = err instanceof Error ? err.message : typeof err === "string" ? err : "no user";
      this.logger.warn(`google callback failed: ${code} (cause: ${cause})`);
      return { authError: code } satisfies GoogleAuthError;
    }
    return user;
  }

  /**
   * Thread the cross-domain success URL through the OAuth `state` param: when the
   * authorize URL carries `?returnTo=`, it round-trips as `state` and the callback
   * redirects back there with a one-time pid_code (see SsoService).
   *
   * M3: the return target is re-wrapped in a server-signed envelope carrying a
   * fresh nonce, and the nonce is dropped in an HttpOnly cookie (10-min TTL).
   * The callback verifies signature + nonce BEFORE trusting the state — an
   * unsigned/foreign/tampered/replayed state never reaches `decodeState`.
   */
  getAuthenticateOptions(context: ExecutionContext): Record<string, unknown> {
    const req = context.switchToHttp().getRequest();
    const returnTo = typeof req?.query?.returnTo === "string" ? req.query.returnTo : undefined;
    const options: Record<string, unknown> = { prompt: "select_account" };
    // First-party logins carry no returnTo — bind them to the wallet origin
    // (server-side, never user input) so the callback's state check passes
    // with the same CSRF guarantees instead of failing every first-party
    // login with invalid_state.
    // Unwrap the login-step envelope (plain returnTo or app-bound encoding),
    // then re-wrap it signed + nonce-bound for the Google round-trip.
    // The PKCE challenge (H4) rides along the same envelope so the callback
    // can bind the minted pid_code to the public client's verifier.
    const { returnTo: target, clientId, codeChallenge } = returnTo
      ? decodeState(returnTo)
      : { returnTo: resolveServiceUrls((key, def) => this.config.get(key, def)).walletUrl };
    const nonce = newOAuthNonce();
    const res = context.switchToHttp().getResponse<Response>();
    setOAuthStateCookie(res, this.config, nonce);
    const secret = oauthStateSecret((key, def) => this.config.get(key, def));
    options.state = signOAuthState({ returnTo: target, clientId, codeChallenge }, nonce, secret);
    return options;
  }
}
