import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface AuthenticatedUser {
  pid: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => ctx.switchToHttp().getRequest().user,
);
