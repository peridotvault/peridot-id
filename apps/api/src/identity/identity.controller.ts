import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { Identity } from "@prisma/client";
import { Request, Response } from "express";
import { CurrentUser, AuthenticatedUser } from "../common/current-user.decorator";
import {
  clearAllAccountRefreshCookies,
  clearAllScopedAuthCookies,
  clearAuthCookies,
  clearClaimCookie,
  clearOAuthStateCookie,
} from "../common/cookies";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { IdentityService } from "./identity.service";

@Controller("v1/identity")
@UseGuards(ThrottlerGuard)
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly config: ConfigService,
  ) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<Pick<Identity, "pid" | "status" | "role" | "createdAt">> {
    return this.identityService.getMe(user.pid);
  }

  @Get("credentials")
  @UseGuards(JwtAuthGuard)
  listCredentials(@CurrentUser() user: AuthenticatedUser) {
    return this.identityService.listCredentials(user.pid);
  }

  @Delete("credentials/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async unlinkCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.identityService.unlinkCredential(user.pid, id);
  }

  @Delete("me")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.identityService.deleteAccount(user.pid);
    // The identity is gone: drop every session this browser holds, not just
    // the wallet's unscoped pair — app-scoped sessions, linked-account
    // refresh cookies, any pending claim ticket (M5), and the OAuth state
    // nonce (F3: a stale pid_oauth_state must never survive the identity).
    // Each clear mirrors its set flags, otherwise the clear silently no-ops.
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    clearAuthCookies(res, this.config);
    clearAllScopedAuthCookies(res, this.config, cookies);
    clearAllAccountRefreshCookies(res, this.config, cookies);
    clearClaimCookie(res, this.config);
    clearOAuthStateCookie(res, this.config);
  }
}
