import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Request, Response } from "express";
import { LoginResponse } from "@peridotvault/pid-types";
import { REFRESH_COOKIE } from "../common/cookies";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { AuthenticateFinishDto } from "../credentials/dto/credential.dto";
import { AuthenticateStartResult, CredentialService } from "../credentials/credential.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { AuthService } from "./auth.service";
import { GoogleGuard } from "./google.guard";

@Controller("v1/auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly credentialService: CredentialService,
    private readonly config: ConfigService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  login(@Req() req: Request): LoginResponse {
    const base = `${req.protocol}://${req.get("host")}`;
    return { url: `${base}/v1/auth/google` };
  }

  @Post("passkey/start")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  passkeyStart(): Promise<AuthenticateStartResult> {
    return this.credentialService.loginStart();
  }

  @Post("passkey/finish")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async passkeyFinish(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: AuthenticateFinishDto,
  ): Promise<{ ok: true }> {
    const { identityId } = await this.credentialService.loginFinish({
      authenticationId: dto.authenticationId,
      credential: dto.credential as never,
    });
    await this.authService.issueSession(res, identityId, req.headers["user-agent"]);
    return { ok: true };
  }

  @Get("google")
  @UseGuards(GoogleGuard)
  google(): void {
    // passport redirects to Google
  }

  @Get("google/callback")
  @UseGuards(GoogleGuard)
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const identity = req.user as { id: string };
    await this.authService.issueSession(res, identity.id, req.headers["user-agent"]);
    res.redirect(this.config.get<string>("CLIENT_SUCCESS_URL", "/"));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.rotateSession(req, res);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.logout(req, res);
  }

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async sessions(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown[]> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    const currentJti = await this.authService.currentSessionJti(token);
    return this.authService.listSessions(user.identityId, currentJti);
  }

  @Delete("sessions/revoke-others")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async revokeOtherSessions(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    const currentJti = await this.authService.currentSessionJti(token);
    await this.authService.revokeOtherSessions(user.identityId, currentJti);
    return { ok: true };
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.authService.revokeSession(user.identityId, id);
    return { ok: true };
  }
}
