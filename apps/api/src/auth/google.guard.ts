import { ExecutionContext, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { GOOGLE_OAUTH_OPTIONS, GoogleOAuthOptions } from "./google.strategy";

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

  constructor(@Inject(GOOGLE_OAUTH_OPTIONS) oauthOptions: GoogleOAuthOptions | null) {
    super();
    this.configured = Boolean(oauthOptions);
  }

  canActivate(context: ExecutionContext) {
    if (!this.configured) {
      throw new ServiceUnavailableException("Google OAuth is not configured. Set GOOGLE_CLIENT_ID_DEV/GOOGLE_CLIENT_SECRET_DEV (local) or _PROD (production) in .env");
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
      this.logger.warn(`google callback failed: ${code}`);
      return { authError: code } satisfies GoogleAuthError;
    }
    return user;
  }

  /**
   * Thread the cross-domain success URL through the OAuth `state` param: when the
   * authorize URL carries `?returnTo=`, it round-trips as `state` and the callback
   * redirects back there with a one-time pid_code (see SsoService).
   */
  getAuthenticateOptions(context: ExecutionContext): Record<string, unknown> {
    const req = context.switchToHttp().getRequest();
    const returnTo = typeof req?.query?.returnTo === "string" ? req.query.returnTo : undefined;
    const options: Record<string, unknown> = { prompt: "select_account" };
    if (returnTo) options.state = returnTo;
    return options;
  }
}
