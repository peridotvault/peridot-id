import { ExecutionContext, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { GOOGLE_OAUTH_OPTIONS, GoogleOAuthOptions } from "./google.strategy";

@Injectable()
export class GoogleGuard extends AuthGuard("google") {
  private readonly configured: boolean;

  constructor(@Inject(GOOGLE_OAUTH_OPTIONS) oauthOptions: GoogleOAuthOptions | null) {
    super();
    this.configured = Boolean(oauthOptions);
  }

  canActivate(context: ExecutionContext) {
    if (!this.configured) {
      throw new ServiceUnavailableException("Google OAuth is not configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env");
    }
    return super.canActivate(context) as boolean;
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
