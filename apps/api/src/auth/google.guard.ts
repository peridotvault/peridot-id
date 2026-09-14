import { ExecutionContext, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { GOOGLE_OAUTH_OPTIONS, GoogleOAuthOptions } from "./google.strategy";
import { encodeState } from "./sso.service";

@Injectable()
export class GoogleGuard extends AuthGuard("google") {
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
   * Thread the cross-domain success URL + chosen PID handle through the OAuth
   * `state` param: when the authorize URL carries `?returnTo=`/`?handle=`, they
   * round-trip as `state` and the callback redirects back there with a one-time
   * pid_code (see SsoService). The handle becomes the permanent `<handle>@pid`.
   */
  getAuthenticateOptions(context: ExecutionContext): Record<string, unknown> {
    const req = context.switchToHttp().getRequest();
    const returnTo = typeof req?.query?.returnTo === "string" ? req.query.returnTo : undefined;
    const handle = typeof req?.query?.handle === "string" ? req.query.handle : undefined;
    const options: Record<string, unknown> = { prompt: "select_account" };
    // `returnTo` from /v1/auth/login is already an encoded state blob (handle
    // folded in) — pass through untouched. A standalone `?handle=` (first-party
    // sign-up without SSO) still needs wrapping so it survives the round-trip.
    if (returnTo) options.state = returnTo;
    else if (handle) options.state = encodeState("", undefined, handle);
    return options;
  }
}
