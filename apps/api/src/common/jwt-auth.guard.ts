import { ExecutionContext, ForbiddenException, Injectable, Logger, Optional, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { ACCESS_COOKIE, normalizeScope, scopeAccessCookie } from "./cookies";
import { extractRequestOrigin, getVerifiedAppOrigins, hasSessionCookie } from "./csrf-origin.guard";
import { isOriginAllowed, staticOriginsFor } from "./cors";
import { PrismaService } from "../prisma/prisma.service";
import { mainnetApiBase } from "./app-config";
import { mainnetSession, sessionToken } from "./network-auth";
import { verifyLocalAppToken } from "./local-app-token";
import { pidNetwork } from "./network";

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

  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    super({});
  }

  /**
   * CSRF Origin allowlist (ANT-367): state-changing requests carrying a
   * session cookie must present an allowlisted Origin (else Referer origin).
   * Same allowlist as credentialed CORS — staticOriginsFor() ∪ verified
   * per-app origins (shared TTL cache, never N+1). Safe methods and
   * cookieless (Bearer) flows pass through untouched. Missing/mismatched
   * Origin on a cookie request fails closed with 403. Skipped only when the
   * guard was constructed without DI config (unit tests calling
   * `new JwtAuthGuard()` directly) — production always injects ConfigService.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (this.config && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
      if (hasSessionCookie(cookies)) {
        const origin = extractRequestOrigin(req);
        const allowed =
          !!origin &&
          isOriginAllowed(origin, staticOriginsFor(this.config), await getVerifiedAppOrigins(this.prisma));
        if (!allowed) {
          this.logger.warn(`rejected cookie-authed ${req.method} ${req.path}: origin not allowlisted`);
          throw new ForbiddenException("Origin not allowed for cookie-authenticated request");
        }
      }
    }
    // Testnet stack: no identity tables locally, so the session is resolved
    // against the mainnet API (introspection, cached) instead of a local secret.
    if (this.config && pidNetwork(this.config.get<string>("PID_NETWORK")) === "testnet") {
      // App (machine) tokens are MINTED by this stack (its own `pid_apps`), so
      // they can never be introspected on mainnet — verify the local signature
      // first. User sessions are never minted here, so a local pass is always
      // an app token.
      const local = this.localAppToken(req);
      if (local) {
        this.assertMethodAllowed(local, req);
        (req as Request & { user?: unknown }).user = local;
        return true;
      }
      const session = await mainnetSession(req, {
        network: "testnet",
        baseUrl: mainnetApiBase((key, def) => this.config?.get(key, def)),
      });
      if (!session) throw new UnauthorizedException("Sign in on PeridotID mainnet first");
      this.assertMethodAllowed(session, req);
      (req as Request & { user?: unknown }).user = {
        pid: session.pid,
        method: "mainnet",
        ...(session.scope ? { scope: session.scope } : {}),
        ...(session.app ? { app: session.app } : {}),
      };
      return true;
    }
    return (await super.canActivate(context)) as boolean;
  }

  /**
   * Locally-signed app token for this testnet request, or null (then the guard
   * falls back to mainnet introspection). Only the `pid-app` audience passes.
   */
  private localAppToken(req: Request): { pid: string; app: string; scope?: string } | null {
    const token = sessionToken(req);
    const secret = this.config?.get<string>("JWT_ACCESS_SECRET");
    if (!token || !secret) return null;
    return verifyLocalAppToken(token, secret);
  }

  /**
   * Read-scope / machine-token write rules, shared by the cookie path
   * (`handleRequest`) and the testnet introspection path so both deployments
   * enforce exactly the same limits.
   */
  private assertMethodAllowed(auth: { app?: string; scope?: string } | null | undefined, req: Request): void {
    if (!auth) return;
    if (auth.scope === "read") {
      if (req.method !== "GET" && req.method !== "HEAD" && !READ_SCOPE_WRITE_ALLOW.some((re) => re.test(req.path))) {
        throw new ForbiddenException("This token is read-only");
      }
      return;
    }
    if (!auth.app) return;
    // ANT-344 H3: transfer power requires the explicit transfer scope.
    if (auth.scope !== "fiat:transfer" && req.method !== "GET" && req.method !== "HEAD" && /^\/v1\/fiat\/transfers(\/|$)/.test(req.path)) {
      if (auth.scope === undefined) {
        this.logger.warn(`rejected legacy app token without scope: app=${auth.app}`);
      }
      throw new ForbiddenException("Machine token scope not authorized for transfers");
    }
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
    this.assertMethodAllowed(authed as { app?: string; scope?: string } | null, context.switchToHttp().getRequest<Request>());
    return authed;
  }
}

export { cookieExtractor };
