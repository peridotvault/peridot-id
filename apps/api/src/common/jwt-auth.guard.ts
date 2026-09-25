import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { ACCESS_COOKIE } from "./cookies";

const cookieExtractor = (req: Request): string | null => {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE];
  return cookie ?? null;
};

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
      const method = context.switchToHttp().getRequest<Request>().method;
      if (method !== "GET" && method !== "HEAD") {
        throw new ForbiddenException("This token is read-only");
      }
    }
    return authed;
  }
}

export { cookieExtractor };
