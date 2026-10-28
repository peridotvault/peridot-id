import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Request, Response } from "express";
import { LoginResponse } from "@peridotvault/pid-types";
import { CLAIM_COOKIE, REFRESH_COOKIE, clearClaimCookie, clearOAuthStateCookie, normalizeScope, OAUTH_STATE_COOKIE, setClaimCookie } from "../common/cookies";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { AuthenticateFinishDto } from "../credentials/dto/credential.dto";
import { AuthenticateStartResult, CredentialService } from "../credentials/credential.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CsrfOriginGuard } from "../common/csrf-origin.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { AuthService } from "./auth.service";
import { isPidHandle, normalizePidHandle } from "../common/pid";
import { ClaimService, isUnverifiedEmailError } from "./claim.service";
import { EmailStartDto, EmailVerifyDto } from "./email/dto/email.dto";
import { EmailOtpService } from "./email/email-otp.service";
import { GoogleGuard, isGoogleAuthError } from "./google.guard";
import { isPendingGoogleClaim } from "./google.strategy";
import { ExchangeDto, AuthorizeDto, ClaimDto, LoginDto, AppTokenDto, SwitchAccountDto, GrantScopeDto } from "./dto/auth.dto";
import { PidAppsService } from "./apps.service";
import { encodeState, isLoopbackReturnTo, SsoCodeInvalidError, SsoService } from "./sso.service";
import { randomBytes } from "node:crypto";
import { oauthStateSecret, verifyOAuthState } from "./oauth-state";
import { resolveServiceUrls } from "../common/app-config";

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
@UseGuards(ThrottlerGuard, CsrfOriginGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly credentialService: CredentialService,
    private readonly ssoService: SsoService,
    private readonly claimService: ClaimService,
    private readonly emailOtp: EmailOtpService,
    private readonly apps: PidAppsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Machine token for an app's backend (client-credentials). Bound to the app
   * owner's pid; carries the app's clientId (fee context + non-admin). Send it
   * as `Authorization: Bearer <token>`. No browser session required.
   * Optional `scope: "fiat:transfer"` mints the least-privilege escrow-release
   * form (ANT-286b) — pass it through to the token's scope claim.
   */
  @Post("token")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async appToken(@Body() dto: AppTokenDto) {
    const app = await this.apps.findActive(dto.clientId);
    if (!app) throw new UnauthorizedException("Invalid client");
    if (!this.apps.clientSecretValid(app, dto.clientSecret ?? "")) {
      throw new UnauthorizedException("Invalid client");
    }
    return this.authService.issueAppAccessToken(app.ownerPid, app.clientId, dto.scope);
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
      // H4: the PKCE challenge rides the state envelope to the callback, which
      // binds it into the minted pid_code (public clients must present one —
      // issue() fails closed without it). The verified gate itself is enforced
      // at callback time, not here.
      // state round-trips through Google: carries returnTo (+ clientId when present).
      // Handles are never chosen here — new credentials land on the PID picker.
      url += `?returnTo=${encodeURIComponent(encodeState(resolved.redirectTo, resolved.clientId, dto.codeChallenge))}`;
    }
    return { url };
  }

  @Get("pid/available")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async pidAvailable(@Req() req: Request): Promise<{ available: boolean; pid: string | null }> {
    // Spec marks `handle` required with `^[a-z0-9_]{3,20}$`: a missing or
    // malformed handle is a 400 (not a 200 `available:false`, which would read
    // as "taken"). Same message/shape as ClaimDto validation. The service
    // stays lenient (returns false) as defense-in-depth; the boundary owns 400.
    const raw = typeof req.query.handle === "string" ? req.query.handle : "";
    const normalized = normalizePidHandle(raw);
    if (!isPidHandle(normalized)) {
      throw new BadRequestException("handle must be 3-20 chars: lowercase letters, numbers, underscore");
    }
    return this.authService.isPidAvailable(normalized);
  }

  /**
   * Public trust signal for login consent screens: an active app's display
   * name + verified-partner flag. Secrets never leave the server — only these
   * two fields. 404 for unknown/disabled apps.
   */
  @Get("app-info")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async appInfo(@Req() req: Request): Promise<{ name: string; isVerified: boolean }> {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
    const app = clientId ? await this.apps.findActive(clientId) : null;
    if (!app) throw new NotFoundException("App not found");
    return { name: app.name, isVerified: app.isVerified };
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
      // H4: silent auto-issue is first-party/verified-only. Unverified apps
      // must use the explicit consent endpoint (authorize) so the user sees
      // the app's name + unverified warning before any code is minted.
      try {
        this.ssoService.requireVerifiedForAutoIssue(resolved);
      } catch {
        throw new BadRequestException(
          "App is not verified — approve it on the PeridotID consent screen before continuing.",
        );
      }
      let pidCode: string;
      try {
        pidCode = await this.ssoService.issue(pid, resolved.redirectTo, {
          clientId: resolved.clientId,
          ...(dto.codeChallenge ? { codeChallenge: dto.codeChallenge } : {}),
        });
      } catch (err) {
        if (err instanceof Error && err.message === "sso_pkce_invalid") {
          throw new BadRequestException("A code_challenge is required for this app (public client).");
        }
        throw err;
      }
      return { ok: true, pidCode };
    }
    return { ok: true };
  }

  @Post("email/start")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async emailStart(@Req() req: Request, @Body() dto: EmailStartDto): Promise<{ ok: true }> {
    return this.emailOtp.request(dto.email, req.ip);
  }

  @Post("email/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async emailVerify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: EmailVerifyDto,
  ): Promise<{ ok: true; pidCode?: string; pendingClaim?: boolean }> {
    const email = await this.emailOtp.verify(dto.email, dto.code);
    const resolved = await this.ssoService.resolveReturnTo(dto.returnTo, dto.clientId);
    if (dto.returnTo && !resolved) {
      throw new BadRequestException("returnTo is not an allowed origin");
    }

    // Returning credential → session, same as Google/passkey. Reconcile by
    // verified email too: the same person who claimed via Google keeps their PID
    // (one email = one PID) rather than being sent to the picker.
    const identity =
      (await this.authService.findCredentialIdentity("email", email)) ??
      (await this.authService.findIdentityByEmail(email));
    if (identity) {
      await this.authService.issueSession(res, identity.pid, req.headers["user-agent"], undefined, "email");
      if (resolved) {
        // H4: same verified-gate as passkey — unverified apps go through consent.
        try {
          this.ssoService.requireVerifiedForAutoIssue(resolved);
        } catch {
          throw new BadRequestException(
            "App is not verified — approve it on the PeridotID consent screen before continuing.",
          );
        }
        let pidCode: string;
        try {
          pidCode = await this.ssoService.issue(identity.pid, resolved.redirectTo, {
            clientId: resolved.clientId,
            ...(dto.codeChallenge ? { codeChallenge: dto.codeChallenge } : {}),
          });
        } catch (err) {
          if (err instanceof Error && err.message === "sso_pkce_invalid") {
            throw new BadRequestException("A code_challenge is required for this app (public client).");
          }
          throw err;
        }
        return { ok: true, pidCode };
      }
      return { ok: true };
    }

    // New credential → claim ticket + PID picker, same as the Google branch.
    const ticketId = await this.claimService.mintCredential(
      { provider: "email", providerUserId: email, email },
      undefined,
      ...(resolved ? [{ redirectTo: resolved.redirectTo, clientId: resolved.clientId }] : []),
    );
    setClaimCookie(res, this.config, ticketId);
    return { ok: true, pendingClaim: true };
  }

  @Post("exchange")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async exchange(@Body() dto: ExchangeDto) {
    try {
      return await this.ssoService.consume(dto.code, dto.redirectUri, dto.clientId, dto.clientSecret, dto.codeVerifier);
    } catch (err) {
      // ANT-693: the public error stays uniform (no oracle for code scanners),
      // but the failure is now observable: server log carries the machine
      // reason + correlation id, and the caller gets both plus an actionable
      // checklist (redirect_uri exactness, secret, single-use/TTL) instead of
      // a bare silent 400. Sandbox debugging starts from the correlation id.
      const reason = err instanceof SsoCodeInvalidError ? err.reason : "internal";
      const correlationId = randomBytes(8).toString("hex");
      this.logger.warn(`exchange failed: reason=${reason} correlationId=${correlationId}`);
      throw new BadRequestException({
        error: "sso_code_invalid",
        message:
          "Code is invalid, expired, or already used. Check: redirect_uri must exactly match the login target, " +
          "the app secret must be current when the app has one, and each code is single-use (60s TTL).",
        correlationId,
      });
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
  @UseGuards(JwtAuthGuard, UserTokenGuard)
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
    const pidCode = await this.ssoService.issue(user.pid, resolved.redirectTo, {
      clientId: resolved.clientId,
      ...(dto.codeChallenge ? { codeChallenge: dto.codeChallenge } : {}),
    });
    return { pidCode };
  }

  @Get("grants")
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async grants(@CurrentUser() user: AuthenticatedUser) {
    return this.ssoService.listGrants(user.pid);
  }

  /**
   * Identities signed into this browser (wallet account switcher). Resolved from
   * the httpOnly per-identity refresh cookies, so it works even with an expired
   * access token. Returns only identities this browser actually holds.
   */
  @Get("accounts")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async accounts(@Req() req: Request) {
    return this.authService.listAccounts(req);
  }

  /** Make a linked identity active without re-authenticating (rotates the access cookie). */
  @Post("accounts/switch")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async switchAccount(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SwitchAccountDto,
  ): Promise<{ ok: true; pid: string }> {
    await this.authService.switchAccount(req, res, dto.pid);
    return { ok: true, pid: dto.pid };
  }

  /** Forget one identity in this browser (revokes its session, leaves the rest). */
  @Post("accounts/signout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async signOutAccount(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SwitchAccountDto,
  ): Promise<{ ok: true }> {
    await this.authService.signOutAccount(req, res, dto.pid);
    return { ok: true };
  }

  @Delete("grants/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
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
    // Wallet landing URL derived from the ONE service-URL set (WALLET_URL;
    // CLIENT_SUCCESS_URL still reads as a deprecated cutover fallback).
    const successUrl = resolveServiceUrls((key, def) => this.config.get(key, def)).walletUrl;
    // Strategy/transport failure arrives as a marker (see GoogleGuard) — send the
    // user back to retry UI, never a raw 500 JSON dead end.
    if (isGoogleAuthError(req.user)) {
      this.logger.warn(`google callback failed: ${req.user.authError}`);
      res.redirect(withErrorFlag(successUrl, req.user.authError));
      return;
    }
    // M3: `state` round-tripped through the user agent and Google — it is
    // attacker-visible until the guard signed it. Verify the signature AND the
    // HttpOnly nonce cookie BEFORE trusting (or even decoding) it. Unsigned,
    // foreign, tampered, replayed, or expired states bounce to retry UI with
    // `invalid_state` and never reach resolveReturnTo.
    const rawState = typeof req.query.state === "string" ? req.query.state : undefined;
    const nonce = (req as Request & { cookies?: Record<string, string> }).cookies?.[OAUTH_STATE_COOKIE];
    clearOAuthStateCookie(res, this.config);
    const verified = verifyOAuthState(
      rawState,
      nonce,
      oauthStateSecret((key, def) => this.config.get(key, def)),
    );
    if (!verified) {
      this.logger.warn("google callback: invalid oauth state (bad signature, nonce mismatch, or expired)");
      res.redirect(withErrorFlag(successUrl, "invalid_state"));
      return;
    }
    const { returnTo, clientId, codeChallenge } = verified;
    // First-party logins were bound to the wallet origin by the guard (no
    // cross-origin target): land on the wallet with the session, exactly like
    // pre-M3 — no pid_code minted, no allowlist lookup.
    const firstParty = !clientId && returnTo === successUrl;
    const resolved = !firstParty && returnTo ? await this.ssoService.resolveReturnTo(returnTo, clientId) : null;

    // Verified credential, no identity yet → mint a claim ticket and send the
    // user to the PID picker. Nothing is created until they claim. An
    // unverified Google email never becomes a ticket (ClaimService enforces
    // the verified-email gate) — back to retry UI with a specific code.
    if (isPendingGoogleClaim(req.user)) {
      try {
        const ticketId = await this.claimService.mint(req.user.claimProfile, {
          ...(resolved ? { redirectTo: resolved.redirectTo, clientId: resolved.clientId } : {}),
        });
        setClaimCookie(res, this.config, ticketId);
      } catch (err) {
        // F2: only the verified-email-gate rejection maps to `email_unverified`
        // (matched on its stable code, not the bare 400). Any other mint()
        // failure propagates as its real error instead of a misleading label.
        if (isUnverifiedEmailError(err)) {
          this.logger.warn("google callback: unverified email, no claim ticket minted");
          res.redirect(withErrorFlag(successUrl, "email_unverified"));
          return;
        }
        throw err;
      }
      this.logger.log("google callback: claim ticket minted");
      res.redirect(withClaimFlag(successUrl));
      return;
    }

    const identity = req.user as { pid: string };
    await this.authService.issueSession(res, identity.pid, req.headers["user-agent"], undefined, "google");

    if (resolved) {
      // H4: unverified apps are not auto-issued here — the user lands on the
      // wallet with a session and approves via the consent screen (authorize).
      // Redirect without a code so no phishing-grade pid_code leaks silently.
      try {
        this.ssoService.requireVerifiedForAutoIssue(resolved);
      } catch {
        this.logger.warn(`google callback: unverified app ${resolved.clientId} — no auto pid_code, consent required`);
        res.redirect(resolved.redirectTo);
        return;
      }
      let pidCode: string;
      try {
        pidCode = await this.ssoService.issue(identity.pid, resolved.redirectTo, {
          clientId: resolved.clientId,
          ...(codeChallenge ? { codeChallenge } : {}),
        });
      } catch (err) {
        if (err instanceof Error && err.message === "sso_pkce_invalid") {
          this.logger.warn(`google callback: public client ${resolved.clientId} missing code_challenge`);
          res.redirect(withErrorFlag(successUrl, "pkce_required"));
          return;
        }
        throw err;
      }
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
    const { pid, redirectTo, clientId, provider } = await this.claimService.claim(ticketId, dto.handle);
    await this.authService.issueSession(res, pid, req.headers["user-agent"], undefined, provider === "email" ? "email" : "google");
    clearClaimCookie(res, this.config);
    if (redirectTo) {
      const resolved = await this.ssoService.resolveReturnTo(redirectTo, clientId);
      if (resolved) {
        // H4: unverified apps are not auto-issued on claim — the new user
        // lands on the wallet with a session and approves via consent.
        try {
          this.ssoService.requireVerifiedForAutoIssue(resolved);
        } catch {
          return { ok: true, pid };
        }
        let pidCode: string;
        try {
          pidCode = await this.ssoService.issue(pid, resolved.redirectTo, {
            clientId: resolved.clientId,
            ...(dto.codeChallenge ? { codeChallenge: dto.codeChallenge } : {}),
          });
        } catch (err) {
          if (err instanceof Error && err.message === "sso_pkce_invalid") {
            throw new BadRequestException("A code_challenge is required for this app (public client).");
          }
          throw err;
        }
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
    await this.authService.rotateSession(req, res, normalizeScope(req.headers["x-pid-scope"]));
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    // A scoped client logs out only its own session — never the wallet's.
    await this.authService.logout(req, res, normalizeScope(req.headers["x-pid-scope"]));
  }

  /**
   * Mint an independent session for a first-party client app: sets that app's
   * own (`pid_access_<scope>`) cookies from the caller's wallet session. The
   * wallet session is untouched, so app and wallet log out independently.
   */
  @Post("session/scope")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async grantScope(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GrantScopeDto,
  ): Promise<{ ok: true; scope: string }> {
    await this.authService.grantAppSession(res, user.pid, dto.scope, req.headers["user-agent"]);
    return { ok: true, scope: dto.scope };
  }

  @Get("sessions")
  @UseGuards(JwtAuthGuard, UserTokenGuard)
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
  @UseGuards(JwtAuthGuard, UserTokenGuard)
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
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.authService.revokeSession(user.pid, id);
    return { ok: true };
  }
}
