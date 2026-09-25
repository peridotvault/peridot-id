import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { AdminBackfillDto, CheckoutDepositDto, CreateFeePolicyDto } from "./dto/subaccount.dto";

/**
 * Fiat money-in. DOKU Checkout is the funding rail (no Sub-Account): a paid
 * Checkout invoice credits the user's balance on the internal fiat ledger
 * (`/v1/fiat` ledger routes, FiatLedgerController). Balances, statements and
 * transfers all live on that ledger — DOKU is only where money enters.
 */
@Controller("v1/fiat")
@UseGuards(ThrottlerGuard)
export class FiatController {
  constructor(private readonly fiat: FiatSubAccountService) {}

  /** Fee policy (PeridotID fee, separate from DOKU's own fee). */
  @Get("fee-policy")
  @UseGuards(JwtAuthGuard)
  feePolicy() {
    return this.fiat.feePolicy();
  }

  /** Recent deposit intents for the caller (money-in history). */
  @Get("deposits")
  @UseGuards(JwtAuthGuard)
  deposits(@CurrentUser() user: AuthenticatedUser) {
    return this.fiat.txs(user.pid);
  }

  /**
   * Create a Checkout deposit intent: DOKU-hosted page (all banks, QRIS,
   * e-money, cards). netAmountIdr is the NET credited to the user (minimum
   * Rp100.000); PeridotID fee + gross payable are quoted upfront.
   */
  @Post("deposits/checkout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  checkoutDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDepositDto) {
    return this.fiat.createCheckoutDeposit(user.pid, dto.netAmountIdr, dto.clientId);
  }

  /**
   * Corroborate a pending Checkout deposit against DOKU and, on payment,
   * credit the internal fiat ledger. Webhooks may lag or (in local dev) never
   * arrive, so the wallet checks on demand — same server-side path.
   */
  @Post("deposits/:id/sync")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  syncDeposit(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.fiat.syncTx(user.pid, id);
  }

  /**
   * DOKU notification inbox — PUBLIC (unsigned contract). Persist-first, then
   * apply only after server-side corroboration; always 200 after persist.
   */
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  webhook(@Headers("x-external-id") externalId: string | undefined, @Req() req: Request) {
    const rawBody: string = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    return this.fiat.webhook(externalId ?? (req.headers["x-external-id"] as string | undefined), rawBody);
  }

  /** Admin: backfill ledger credit for paid deposits that missed issuance. */
  @Post("admin/backfill")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  backfill(@Body() dto: AdminBackfillDto) {
    return this.fiat.adminBackfill(dto);
  }

  /** Admin: inspect the DOKU notification inbox (received vs applied). */
  @Get("admin/webhooks")
  @UseGuards(JwtAuthGuard, AdminGuard)
  webhooks(@Query("status") status?: string) {
    return this.fiat.webhookEvents(status);
  }

  /** Admin: publish a new fee-policy version (deactivates the previous). */
  @Post("admin/fee-policy")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  feePolicyUpdate(@Body() dto: CreateFeePolicyDto) {
    return this.fiat.createFeePolicy(dto);
  }
}
