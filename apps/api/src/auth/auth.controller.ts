import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Request, Response } from "express";
import { LoginResponse } from "@peridotvault/pid-types";
import { CLAIM_COOKIE, REFRESH_COOKIE, clearClaimCookie, setClaimCookie } from "../common/cookies";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { AuthenticateFinishDto } from "../credentials/dto/credential.dto";
import { AuthenticateStartResult, CredentialService } from "../credentials/credential.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { AuthService } from "./auth.service";
import { ClaimService } from "./claim.service";
import { GoogleGuard, isGoogleAuthError } from "./google.guard";
import { isPendingGoogleClaim } from "./google.strategy";
import { ExchangeDto, AuthorizeDto, ClaimDto, LoginDto, AppTokenDto } from "./dto/auth.dto";
import { PidAppsService } from "./apps.service";
import { decodeState, encodeState, SsoService } from "./sso.service";

/** Redirect target with a pid_code appended (keeps any existing query string). */
function withPidCode(returnTo: string, pidCode: string): string {
  const url = new URL(returnTo);
  url.searchParams.set("pid_code", pidCode);
  return url.toString();
}

/** First-party landing URL with the claim flag (HttpOnly cookie carries the ticket). */
function withClaimFlag(successUrl: string): string {
  if (/^https?:\/\//.test(successUrl)) {
    const url = new URL(successUrl);
    url.searchParams.set("claim", "1");
    return url.toString();
  }
  return successUrl.includes("?") ? `${successUrl}&claim=1` : `${successUrl}?claim=1`;
}

/** First-party landing URL with a retryable error code (cause stays server-side). */
function withErrorFlag(successUrl: string, code: string): string {
  if (/^https?:\/\//.test(successUrl)) {
    const url = new URL(successUrl);
    url.searchParams.set("error", code);
    return url.toString();
  }
  const sep = successUrl.includes("?") ? "&" : "?";
  return `${successUrl}${sep}error=${encodeURIComponent(code)}`;
}

@Controller("v1/auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly credentialService: CredentialService,
    private readonly ssoService: SsoService,
    private readonly claimService: ClaimService,
    private readonly apps: PidAppsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Machine token for an app's backend (client-credentials). Bound to the app
   * owner's pid; carries the app's clientId (fee context + non-admin). Send it
   * as `Authorization: Bearer <token>`. No browser session required.
   */
  @Post("token")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async appToken(@Body() dto: AppTokenDto) {
    const app = await this.apps.findActive(dto.clientId);
    if (!app) throw new UnauthorizedException("Invalid client");
    if (app.clientSecretHash && !PidAppsService.secretMatches(dto.clientSecret ?? "", app.clientSecretHash)) {
      throw new UnauthorizedException("Invalid client");
    }
    return this.authService.issueAppAccessToken(app.ownerPid, app.clientId);
  }

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
      // state round-trips through Google: carries returnTo (+ clientId when present).
      // Handles are never chosen here — new credentials land on the PID picker.
      url += `?returnTo=${encodeURIComponent(encodeState(resolved.redirectTo, resolved.clientId))}`;
    }
    return { url };
  }

  @Get("pid/available")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async pidAvailable(@Req() req: Request): Promise<{ available: boolean; pid: string | null }> {
    const handle = typeof req.query.handle === "string" ? req.query.handle : "";
    return this.authService.isPidAvailable(handle);
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
    const { pid } = await this.credentialService.loginFinish({
      authenticationId: dto.authenticationId,
      credential: dto.credential as never,
    });
    await this.authService.issueSession(res, pid, req.headers["user-agent"], undefined, "passkey");
    if (dto.returnTo) {
      const resolved = await this.ssoService.resolveReturnTo(dto.returnTo, dto.clientId);
      if (!resolved) {
        throw new BadRequestException("returnTo is not an allowed origin");
      }
      const pidCode = await this.ssoService.issue(pid, resolved.redirectTo, { clientId: resolved.clientId });
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
    if (await this.ssoService.isRevoked(user.pid, resolved.redirectTo)) {
      throw new BadRequestException("App connection revoked — sign in again from the site to reconnect.");
    }
    const pidCode = await this.ssoService.issue(user.pid, resolved.redirectTo, { clientId: resolved.clientId });
    return { pidCode };
  }

  @Get("grants")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async grants(@CurrentUser() user: AuthenticatedUser) {
    return this.ssoService.listGrants(user.pid);
  }

  @Delete("grants/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async revokeGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.ssoService.revokeGrant(user.pid, id);
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
    const successUrl = this.config.get<string>("CLIENT_SUCCESS_URL", "/");
    // Strategy/transport failure arrives as a marker (see GoogleGuard) — send the
    // user back to retry UI, never a raw 500 JSON dead end.
    if (isGoogleAuthError(req.user)) {
      this.logger.warn(`google callback failed: ${req.user.authError}`);
      res.redirect(withErrorFlag(successUrl, req.user.authError));
      return;
    }
    // state is user-controlled (comes back via Google) — re-validate before trusting it.
    const rawState = typeof req.query.state === "string" ? req.query.state : undefined;
    const { returnTo, clientId } = rawState ? decodeState(rawState) : { returnTo: undefined, clientId: undefined };
    const resolved = returnTo ? await this.ssoService.resolveReturnTo(returnTo, clientId) : null;

    // Verified credential, no identity yet → mint a claim ticket and send the
    // user to the PID picker. Nothing is created until they claim.
    if (isPendingGoogleClaim(req.user)) {
      const ticketId = await this.claimService.mint(req.user.claimProfile, {
        ...(resolved ? { redirectTo: resolved.redirectTo, clientId: resolved.clientId } : {}),
      });
      setClaimCookie(res, this.config, ticketId);
      this.logger.log("google callback: claim ticket minted");
      res.redirect(withClaimFlag(successUrl));
      return;
    }

    const identity = req.user as { pid: string };
    await this.authService.issueSession(res, identity.pid, req.headers["user-agent"], undefined, "google");

    if (resolved) {
      const pidCode = await this.ssoService.issue(identity.pid, resolved.redirectTo, { clientId: resolved.clientId });
      res.redirect(withPidCode(resolved.redirectTo, pidCode));
      return;
    }
    res.redirect(successUrl);
  }

  @Get("claim/status")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async claimStatus(@Req() req: Request): Promise<{ pending: boolean; email?: string | null; displayName?: string | null; avatarUrl?: string | null }> {
    const ticketId = (req as Request & { cookies?: Record<string, string> }).cookies?.[CLAIM_COOKIE];
    const ticket = await this.claimService.status(ticketId);
    if (!ticket) return { pending: false };
    return { pending: true, ...ticket };
  }

  @Post("claim")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async claim(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ClaimDto,
  ): Promise<{ ok: true; pid: string; pidCode?: string; redirectTo?: string }> {
    const ticketId = (req as Request & { cookies?: Record<string, string> }).cookies?.[CLAIM_COOKIE];
    if (!ticketId) throw new BadRequestException("No pending claim — sign in again to get a fresh one.");
    const { pid, redirectTo, clientId } = await this.claimService.claim(ticketId, dto.handle);
    // Claim entry is Google-only today, hence the google family.
    await this.authService.issueSession(res, pid, req.headers["user-agent"], undefined, "google");
    clearClaimCookie(res, this.config);
    if (redirectTo) {
      const resolved = await this.ssoService.resolveReturnTo(redirectTo, clientId);
      if (resolved) {
        const pidCode = await this.ssoService.issue(pid, resolved.redirectTo, { clientId: resolved.clientId });
        return { ok: true, pid, pidCode, redirectTo: resolved.redirectTo };
      }
    }
    return { ok: true, pid };
  }

  @Delete("claim")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async abandonClaim(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const ticketId = (req as Request & { cookies?: Record<string, string> }).cookies?.[CLAIM_COOKIE];
    await this.claimService.abandon(ticketId);
    clearClaimCookie(res, this.config);
    return { ok: true };
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
    return this.authService.listSessions(user.pid, currentJti);
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
    await this.authService.revokeOtherSessions(user.pid, currentJti);
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
    await this.authService.revokeSession(user.pid, id);
    return { ok: true };
  }
}
