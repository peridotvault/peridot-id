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
}
