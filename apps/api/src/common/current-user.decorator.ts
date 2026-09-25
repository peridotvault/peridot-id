import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface AuthenticatedUser {
  pid: string;
  /** Set when the request used a machine (client-credentials) token — the app's clientId. */
  app?: string;
  /** "read" = token is limited to safe (GET) routes. */
  scope?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => ctx.switchToHttp().getRequest().user,
);
