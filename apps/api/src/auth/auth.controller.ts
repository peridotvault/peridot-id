import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
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
import { ExchangeDto, AuthorizeDto, LoginDto } from "./dto/auth.dto";
import { decodeState, encodeState, SsoService } from "./sso.service";

/** Redirect target with a pid_code appended (keeps any existing query string). */
function withPidCode(returnTo: string, pidCode: string): string {
  const url = new URL(returnTo);
  url.searchParams.set("pid_code", pidCode);
  return url.toString();
}

@Controller("v1/auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly credentialService: CredentialService,
    private readonly ssoService: SsoService,
    private readonly config: ConfigService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async login(@Req() req: Request, @Body() dto: LoginDto): Promise<LoginResponse> {
    const base = `${req.protocol}://${req.get("host")}`;
    let url = `${base}/v1/auth/google`;
    if (dto.returnTo) {
      const resolved = await this.ssoService.resolveReturnTo(dto.returnTo, dto.clientId);
      if (!resolved) {
        throw new BadRequestException("returnTo is not an allowed origin");
      }
      // state round-trips through Google: carries returnTo (+ clientId when present)
      url += `?returnTo=${encodeURIComponent(encodeState(resolved.redirectTo, resolved.clientId))}`;
    }
    return { url };
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
  ): Promise<{ ok: true; pidCode?: string }> {
    const { identityId } = await this.credentialService.loginFinish({
      authenticationId: dto.authenticationId,
      credential: dto.credential as never,
    });
    await this.authService.issueSession(res, identityId, req.headers["user-agent"], undefined, "passkey");
    if (dto.returnTo) {
      const resolved = await this.ssoService.resolveReturnTo(dto.returnTo, dto.clientId);
      if (!resolved) {
        throw new BadRequestException("returnTo is not an allowed origin");
      }
      const pidCode = await this.ssoService.issue(identityId, resolved.redirectTo, { clientId: resolved.clientId });
      return { ok: true, pidCode };
    }
    return { ok: true };
  }

  @Post("exchange")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async exchange(@Body() dto: ExchangeDto) {
    try {
      return await this.ssoService.consume(dto.code, dto.clientId, dto.clientSecret);
    } catch {
      throw new BadRequestException("Code is invalid, expired, or already used");
    }
  }

  /**
   * Mint a pid_code for the caller's CURRENT session (no re-authentication).
   * Powers consent screens on PeridotID-hosted pages: the user approves, the page
   * redirects itself to returnTo with the code. Cookie-authenticated by definition —
   * only callable same-site, so no CSRF vector beyond the session itself.
   */
  @Post("authorize")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async authorize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AuthorizeDto,
  ): Promise<{ pidCode: string }> {
    const resolved = await this.ssoService.resolveReturnTo(dto.returnTo, dto.clientId);
    if (!resolved) {
      throw new BadRequestException("returnTo is not an allowed origin");
    }
    // One-tap consent is not re-consent: a revoked origin needs a fresh full
    // login (which heals the grant at exchange). Full-login paths bypass this.
    if (await this.ssoService.isRevoked(user.identityId, resolved.redirectTo)) {
      throw new BadRequestException("App connection revoked — sign in again from the site to reconnect.");
    }
    const pidCode = await this.ssoService.issue(user.identityId, resolved.redirectTo, { clientId: resolved.clientId });
    return { pidCode };
  }

  @Get("grants")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async grants(@CurrentUser() user: AuthenticatedUser) {
    return this.ssoService.listGrants(user.identityId);
  }

  @Delete("grants/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async revokeGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.ssoService.revokeGrant(user.identityId, id);
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
    await this.authService.issueSession(res, identity.id, req.headers["user-agent"], undefined, "google");

    // state is user-controlled (comes back via Google) — re-validate before trusting it.
    const rawState = typeof req.query.state === "string" ? req.query.state : undefined;
    if (rawState) {
      const { returnTo, clientId } = decodeState(rawState);
      const resolved = await this.ssoService.resolveReturnTo(returnTo, clientId);
      if (resolved) {
        const pidCode = await this.ssoService.issue(identity.id, resolved.redirectTo, { clientId: resolved.clientId });
        res.redirect(withPidCode(resolved.redirectTo, pidCode));
        return;
      }
    }
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
