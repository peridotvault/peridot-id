import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Request, Response } from "express";
import { setClaimCookie } from "../../common/cookies";
import { AuthenticatedUser, CurrentUser } from "../../common/current-user.decorator";
import { extractRequestOrigin } from "../../common/csrf-origin.guard";
import { CsrfOriginGuard } from "../../common/csrf-origin.guard";
import { JwtAuthGuard } from "../../common/jwt-auth.guard";
import { UserTokenGuard } from "../../common/user-token.guard";
import { AuthService } from "../auth.service";
import { WalletChallengeDto, WalletVerifyDto } from "./dto/wallet-auth.dto";
import { LinkedWalletView, WalletAuthService, WalletChallengeView } from "./wallet-auth.service";

/**
 * External-wallet login (stage 2). Public by design: the proof itself IS the
 * authentication. Linking/unlinking always require a live PID session, and the
 * verified challenge must have been issued FOR that pid.
 */
@Controller("v1/auth/wallet")
@UseGuards(ThrottlerGuard, CsrfOriginGuard)
export class WalletAuthController {
  constructor(
    private readonly wallet: WalletAuthService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Issue a challenge for `action: "login"` (the default). */
  @Post("challenge")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  challenge(@Req() req: Request, @Body() dto: WalletChallengeDto): Promise<WalletChallengeView> {
    return this.wallet.challenge(
      {
        namespace: dto.namespace,
        reference: dto.reference,
        address: dto.address,
        action: "login",
        returnTo: dto.returnTo,
        clientId: dto.clientId,
        codeChallenge: dto.codeChallenge,
      },
      { origin: extractRequestOrigin(req) },
    );
  }

  /**
   * Present the signature. A known address gets a session; a new one gets a
   * claim ticket — nothing is created until the user claims a handle.
   */
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async verify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: WalletVerifyDto,
  ): Promise<{ ok: true; pid?: string; pidCode?: string; pendingClaim?: boolean; claimTicket?: string }> {
    const result = await this.wallet.verifyLogin(dto.challengeId, dto.signature);
    if (result.kind === "claim") {
      setClaimCookie(res, this.config, result.ticketId);
      // The ticket also travels in the body: a cross-origin dapp has no
      // first-party cookie to carry it to the claim step.
      return { ok: true, pendingClaim: true, claimTicket: result.ticketId };
    }
    await this.authService.issueSession(res, result.pid, req.headers["user-agent"], undefined, "wallet");
    return { ok: true, pid: result.pid, ...(result.pidCode ? { pidCode: result.pidCode } : {}) };
  }

  /** Issue a challenge bound to the caller's pid for linking an address. */
  @Post("link/challenge")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  linkChallenge(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WalletChallengeDto,
  ): Promise<WalletChallengeView> {
    return this.wallet.challenge(
      { namespace: dto.namespace, reference: dto.reference, address: dto.address, action: "link" },
      { pid: user.pid, origin: extractRequestOrigin(req) },
    );
  }

  /** Attach the proven wallet to the caller's pid (explicit link only). */
  @Post("link")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  link(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WalletVerifyDto,
  ): Promise<LinkedWalletView> {
    return this.wallet.link(dto.challengeId, dto.signature, user.pid);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  list(@CurrentUser() user: AuthenticatedUser): Promise<LinkedWalletView[]> {
    return this.wallet.list(user.pid);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  unlink(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.wallet.unlink(user.pid, id);
  }
}
