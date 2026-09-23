import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { CheckoutDepositDto, AdminBackfillDto, AdminClawbackDto, AdminSweepDto, CreateFeePolicyDto, CreateSplitRuleDto, CreateSubAccountDto, DebitCancelDto, DebitDto, ReconcileDto, SubHistoryQueryDto, TransferConfirmDto, TransferInquiryDto } from "./dto/subaccount.dto";

/**
 * DOKU Sub-Account V2 routes (1 PID → 1 Sub-Account). Peridot is
 * identity/orchestration; DOKU is the authoritative ledger. No credentials
 * reach the frontend — the B2B token never leaves the backend.
 */
@Controller("v1/fiat/sub-accounts")
@UseGuards(ThrottlerGuard)
export class FiatSubAccountController {
  constructor(private readonly sac: FiatSubAccountService) {}

  @Post("accounts")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSubAccountDto) {
    return this.sac.registerAccount(user.pid, dto);
  }

  @Get("accounts/me")
  @UseGuards(JwtAuthGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.sac.status(user.pid);
  }

  /** Static BRI VA + IDR account for deposits. */
  @Get("deposit-va")
  @UseGuards(JwtAuthGuard)
  depositVa(@CurrentUser() user: AuthenticatedUser) {
    return this.sac.depositVa(user.pid);
  }

  /** Bank-agnostic money-in channels (verified compatibility table). */
  @Get("deposit-channels")
  @UseGuards(JwtAuthGuard)
  depositChannels(@CurrentUser() user: AuthenticatedUser) {
    void user;
    return this.sac.depositChannels();
  }

  /**
   * Create a Checkout deposit intent: DOKU-hosted page (all banks, QRIS,
   * e-money, cards) routed to the caller's sub-account. The requested
   * amount is NET (credited) — minimum Rp100.000, fee quote and gross
   * charge returned upfront. DOKU settles NET → user + FEE → Treasury.
   */
  @Post("deposits/checkout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  checkoutDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDepositDto) {
    return this.sac.createCheckoutDeposit(user.pid, dto.netAmountIdr);
  }

  /** Live balance from DOKU (authoritative). */
  @Get("balance")
  @UseGuards(JwtAuthGuard)
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.sac.balance(user.pid);
  }

  /** Authoritative history from DOKU. */
  @Get("transactions")
  @UseGuards(JwtAuthGuard)
  history(@CurrentUser() user: AuthenticatedUser, @Query() q: SubHistoryQueryDto) {
    return this.sac.history(user.pid, q);
  }

  @Get("ledger")
  @UseGuards(JwtAuthGuard)
  ledger(@CurrentUser() user: AuthenticatedUser) {
    return this.sac.txs(user.pid);
  }

  @Get("fee-policy")
  @UseGuards(JwtAuthGuard)
  feePolicy() {
    return this.sac.feePolicy();
  }

  /** Internal transfer step 1: inquiry only (POINT P2P, moves no money). */
  @Post("transfers/inquiry")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  transferInquiry(@CurrentUser() user: AuthenticatedUser, @Body() dto: TransferInquiryDto) {
    return this.sac.transferInquiry(user.pid, dto);
  }

  /** Transfer step 2: executes the transfer bound to the inquiry. */
  @Post("transfers/:id/confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  transferConfirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: TransferConfirmDto) {
    return this.sac.transferConfirm(user.pid, id, dto);
  }

  @Post("transfers/:id/retry")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  retryTransfer(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.sac.retryTransfer(user.pid, id);
  }

  /** Reconcile a created/processing row via transactions-status. */
  @Post("transactions/:id/sync")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  sync(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.sac.syncTx(user.pid, id);
  }

  @Post("transactions/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.sac.cancelTx(user.pid, id);
  }

  // NOTE: POST transactions/:id/fee was removed. Fee settlement happens
  // natively at DOKU (NET → user sub-account + FEE → Treasury); the API
  // quotes and snapshots fees but never moves fee money.

  /**
   * Reconcile the caller's rows against DOKU history over a window.
   * Backfills missed inbound deposits; flags mismatches and drift.
   */
  @Post("reconcile")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  reconcile(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReconcileDto) {
    return this.sac.reconcile(user.pid, dto);
  }

  /** Live-vs-cached balance drift check (live wins, cache refreshes). */
  @Get("drift")
  @UseGuards(JwtAuthGuard)
  drift(@CurrentUser() user: AuthenticatedUser) {
    return this.sac.driftCheck(user.pid);
  }

  @Post("debits")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  debit(@CurrentUser() user: AuthenticatedUser, @Body() dto: DebitDto) {
    return this.sac.debit(user.pid, dto.amountIdr, dto.description);
  }

  @Post("debits/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  debitCancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: DebitCancelDto) {
    return this.sac.debitCancel(user.pid, id, dto.refundAmountIdr, dto.reason);
  }

  /**
   * Sub-Account notification inbox — PUBLIC (no published signing contract,
   * so the event is persisted first and only applied after DOKU
   * corroboration). Always 200 after persist to avoid retry storms; unknown
   * events stay `received` for admin review.
   */
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  webhook(@Headers("x-external-id") externalId: string | undefined, @Req() req: Request) {
    const rawBody: string = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    return this.sac.webhook(externalId ?? (req.headers["x-external-id"] as string | undefined), rawBody);
  }

  // NOTE: there is deliberately NO route that issues points. Issuance runs
  // only inside webhook/sync/sweep after server-side DOKU corroboration
  // (FiatSubAccountService private methods — CI guard fails the build if
  // any route, SDK method, or wallet screen touches them).

  /** Admin: sweep outstanding issuance + backing report across accounts. */
  @Post("admin/sweep")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  sweep(@Body() dto: AdminSweepDto) {
    return this.sac.adminSweep(dto);
  }

  /** Admin: backfill makeup points for settled deposits missing issuance. */
  @Post("admin/backfill")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  backfill(@Body() dto: AdminBackfillDto) {
    return this.sac.adminBackfill(dto);
  }

  /** Admin: reconstruct historical recipient mirrors (authoritative or review queue). */
  @Post("admin/backfill-mirrors")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  backfillMirrors(@Body() dto: AdminSweepDto) {
    return this.sac.adminBackfillMirrors({ take: dto.take });
  }

  /** Admin: claw back issued points after a failed/charged-back payment. */
  @Post("admin/clawback")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  clawback(@Body() dto: AdminClawbackDto) {
    return this.sac.clawbackPoints(dto);
  }

  /** Admin: inspect the webhook inbox (received vs applied). */
  @Get("admin/webhooks")
  @UseGuards(JwtAuthGuard, AdminGuard)
  webhooks(@Query("status") status?: string) {
    return this.sac.webhookEvents(status);
  }

  /** Admin: immutable journal export + replay verdict for one PID. */
  @Get("admin/journal/:pid")
  @UseGuards(JwtAuthGuard, AdminGuard)
  journal(@Param("pid") pid: string) {
    return this.sac.adminJournal(pid);
  }

  /** Admin: platform-wide replay projection (bounded, see note). */
  @Get("admin/replay")
  @UseGuards(JwtAuthGuard, AdminGuard)
  replay() {
    return this.sac.adminReplay();
  }

  /** Admin: create an automated split rule (applies at settlement, on net). */
  @Post("admin/split-rules")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  splitRule(@Body() dto: CreateSplitRuleDto) {
    return this.sac.createSplitRule(dto.transactionType, dto.rules);
  }

  /** Admin: publish a new fee-policy version (deactivates the previous). */
  @Post("admin/fee-policy")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  feePolicyUpdate(@Body() dto: CreateFeePolicyDto) {
    return this.sac.createFeePolicy(dto);
  }
}
