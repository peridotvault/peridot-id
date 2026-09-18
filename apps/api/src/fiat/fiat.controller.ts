import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { AdminGuard } from "../common/admin.guard";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateTopupDto, RequestWithdrawDto, SettleWithdrawDto } from "./dto/fiat.dto";
import { FiatService } from "./fiat.service";

@Controller("v1/fiat")
@UseGuards(ThrottlerGuard)
export class FiatController {
  constructor(private readonly fiat: FiatService) {}

  /** Fiat-only IDR top-up: creates the invoice and returns the hosted payment page URL. */
  @Post("topup")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  createTopup(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTopupDto) {
    return this.fiat.createTopup(user.pid, dto.amountIdr);
  }

  /** Top-up history (newest first). */
  @Get("topup")
  @UseGuards(JwtAuthGuard)
  topups(@CurrentUser() user: AuthenticatedUser) {
    return this.fiat.topups(user.pid);
  }

  @Get("topup/:id")
  @UseGuards(JwtAuthGuard)
  async topup(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const row = await this.fiat.topup(user.pid, id);
    if (!row) throw new NotFoundException("Top-up not found");
    return row;
  }

  /** IDR withdraw request (MVP: manual settlement — no DOKU Payouts call yet). */
  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  requestWithdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestWithdrawDto) {
    const { amountIdr, ...destination } = dto;
    return this.fiat.requestWithdraw(user.pid, amountIdr, destination);
  }

  @Get("withdraw")
  @UseGuards(JwtAuthGuard)
  withdraws(@CurrentUser() user: AuthenticatedUser) {
    return this.fiat.withdraws(user.pid);
  }

  /** Spendable IDR balance (paid top-ups minus pending + settled withdraws). */
  @Get("balance")
  @UseGuards(JwtAuthGuard)
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.fiat.balance(user.pid);
  }

  /** Admin settlement of a withdraw request (manual payout tracking). */
  @Post("withdraw/:id/settle")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  settleWithdraw(@Param("id") id: string, @Body() dto: SettleWithdrawDto) {
    return this.fiat.settleWithdraw(id, dto.decision);
  }

  /**
   * Provider webhook — PUBLIC (authenticity comes from the gateway signature
   * header over the raw body, not JWT). 200 = processed/idempotent replay,
   * 400 = rejected (the gateway retries).
   */
  @Post("webhook/:provider")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async webhook(
    @Param("provider") provider: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: Request,
  ) {
    const rawBody: string = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const result = await this.fiat.webhook(provider, headers, rawBody, req.path);
    if (!result.ok) throw new BadRequestException("Notification rejected");
    return { ok: true };
  }
}
