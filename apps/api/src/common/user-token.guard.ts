// User-wallet write guard (ANT-233 F1). Machine (client-credentials) tokens
// carry `app` (aud pid-app) and are bound to the app owner's PID — they must
// never perform user-wallet writes (withdraw, execute, rotate, activate,
// intents…). Reads stay allowed; admin routes already reject `app` via
// AdminGuard. Apply as `@UseGuards(JwtAuthGuard, UserTokenGuard)` on every
// non-GET wallet/account route. Fail-closed: missing user or `app` set → 403.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

@Injectable()
export class UserTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest() as { user?: { pid?: string; app?: string } };
    if (!req.user?.pid) throw new ForbiddenException("Authentication required");
    if (req.user.app) throw new ForbiddenException("Machine tokens cannot perform user wallet writes");
    return true;
  }
}
