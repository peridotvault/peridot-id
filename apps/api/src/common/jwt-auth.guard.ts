import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { ACCESS_COOKIE } from "./cookies";

const cookieExtractor = (req: Request): string | null => {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE];
  return cookie ?? null;
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
  constructor() {
    super({});
  }

  /**
   * Tokens with `scope: "read"` (e.g. the SSO exchange token handed to a relying
   * party's backend) are limited to safe methods — they can read balance/ledger
   * but can never trigger a write (transfer, withdraw, credential, profile…).
   * Full machine tokens (`/v1/auth/token`) carry no scope and keep app powers.
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
    }
    return authed;
  }
}

export { cookieExtractor };
