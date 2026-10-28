// ANT-804 §6.1 (claim) + §6.2 (status/takedown) contract surface.
// No `reserved` state anywhere (MVP Opsi A). Rate limits per NFR §9
// (10 req/min/user on claim + reports; 429 + Retry-After via ThrottlerGuard).
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { CLAIM_COOKIE } from "../common/cookies";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { ClaimPidDto, CreateReportDto, DecideReportDto } from "./dto/pids.dto";
import { PidsService } from "./pids.service";

@Controller("v1/pids")
@UseGuards(ThrottlerGuard)
export class PidsController {
  constructor(private readonly pids: PidsService) {}

  /**
   * Contract claim (§6.1): 201 {handle, normalizedHandle, claimedAt},
   * 409 {code:HANDLE_TAKEN}, 400 {code:HANDLE_INVALID}, 429 + Retry-After.
   * Same ticket trust boundary as POST /v1/auth/claim (claim cookie).
   */
  @Post("claim")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async claim(
    @Req() req: Request,
    @Res({ passthrough: true }) _res: Response,
    @Body() dto: ClaimPidDto,
  ) {
    const ticketId = (req as Request & { cookies?: Record<string, string> }).cookies?.[CLAIM_COOKIE];
    return this.pids.claimContract(ticketId, dto.handle, dto.idempotencyKey);
  }

  /** Handle state (§6.2): available | claimed | under_review. Public. */
  @Get(":handle/status")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async status(@Param("handle") handle: string) {
    return this.pids.handleStatus(handle);
  }

  /** File a takedown report (§6.2) → 202 {reportId, slaRespondBy}. */
  @Post("reports")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async createReport(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReportDto) {
    return this.pids.createReport(user.pid, dto);
  }

  /** Report detail (reporter / holder / admin). */
  @Get("reports/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async getReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Headers("x-pid-admin") _admin?: string,
  ) {
    // Admin visibility is resolved via role lookup in the admin path; here
    // the caller sees their own reports/holds only.
    return this.pids.getReport(user.pid, false, id);
  }

  /** Single appeal per decision, within 14 days (AC-D2.4). */
  @Post("reports/:id/appeal")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async appeal(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.pids.appealReport(user.pid, id);
  }

  /** Admin decision: keep | release | transfer (D2.4 remediation ordering). */
  @Post("reports/:id/decision")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  async decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: DecideReportDto,
  ) {
    return this.pids.decideReport(user.pid, id, dto);
  }
}
