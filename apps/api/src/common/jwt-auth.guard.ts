import { ExecutionContext, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { ACCESS_COOKIE, normalizeScope, scopeAccessCookie } from "./cookies";

/**
 * Session cookie selection: a client app sends `x-pid-scope: <app>` and gets its
 * own scoped session; with no scope header (the wallet) we read the unscoped
 * session. Scope format is validated so it can never name another cookie.
 *
 * `walletOrigin` (WALLET_URL) additionally restricts the unscoped wallet
 * session to the wallet's own origin, so a sibling first-party app can't reach it
 * by simply dropping the scope header. Requests with no Origin (non-browser) are
 * unaffected — those authenticate with a Bearer token anyway.
 */
const cookieExtractor = (req: Request, walletOrigin?: string | null): string | null => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const scope = normalizeScope(req.headers["x-pid-scope"]);
  if (scope) return cookies?.[scopeAccessCookie(scope)] ?? null;
  if (walletOrigin) {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && origin.replace(/\/+$/, "") !== walletOrigin.replace(/\/+$/, "")) return null;
  }
  return cookies?.[ACCESS_COOKIE] ?? null;
};

/**
 * Writes a read-scoped (SSO) token may still perform. Deposit sync only
 * corroborates the caller's OWN pending DOKU deposit against the provider and
 * credits their own ledger — it moves no other funds — so a relying party's
 * backend can confirm a checkout without a full app token.
 */
const READ_SCOPE_WRITE_ALLOW = [/^\/v1\/fiat\/deposits\/[^/]+\/sync\/?$/];

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor() {
    super({});
  }

  /**
   * Tokens with `scope: "read"` (e.g. the SSO exchange token handed to a relying
   * party's backend) are limited to safe methods — they can read balance/ledger
   * but can never trigger a write (transfer, withdraw, credential, profile…).
   * ANT-344 H3: machine tokens (`app` claim) on `POST /v1/fiat/transfers/*`
   * must carry `scope: "fiat:transfer"` — unscoped legacy app tokens are
   * rejected fail-closed (migration complete), as is any other scope.
   */
  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const authed = super.handleRequest(err, user, info, context, undefined);
    if (authed && (authed as { scope?: string }).scope === "read") {
      const req = context.switchToHttp().getRequest<Request>();
      if (req.method !== "GET" && req.method !== "HEAD") {
        const allowed = READ_SCOPE_WRITE_ALLOW.some((re) => re.test(req.path));
        if (!allowed) throw new ForbiddenException("This token is read-only");
      }
      return authed;
    }
    const claims = authed as { app?: string; scope?: string } | null | undefined;
    if (authed && claims?.app) {
      // ANT-344 H3: transfer power requires the explicit transfer scope.
      // Legacy unscoped machine tokens are rejected here (no back-compat
      // pass); the SOC signal is the 403 itself plus the service-level
      // `fiat.transfer.app_token` event on allowed uses.
      if (claims.scope !== "fiat:transfer") {
        const req = context.switchToHttp().getRequest<Request>();
        if (req.method !== "GET" && req.method !== "HEAD" && /^\/v1\/fiat\/transfers(\/|$)/.test(req.path)) {
          if (claims.scope === undefined) {
            this.logger.warn(`rejected legacy app token without scope: app=${claims.app}`);
          }
          throw new ForbiddenException("Machine token scope not authorized for transfers");
        }
      }
    }
    return authed;
  }
}

export { cookieExtractor };
