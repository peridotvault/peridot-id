import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { FiatLedgerService } from "./fiat-ledger.service";
import { DispatchEventsDto, LedgerFreezeDto, LedgerTransferInquiryDto } from "./dto/ledger.dto";

/**
 * Fiat ledger routes — the spendable balance, statement and send/receive.
 * Generic infra only: account/identity, balance/credit, immutable journal.
 * No route issues credit directly — issuance runs only inside the service's
 * corroborated deposit-attribution path after server-side DOKU payment
 * corroboration (see FiatController deposits/*).
 */
@Controller("v1/fiat")
@UseGuards(ThrottlerGuard)
export class FiatLedgerController {
  constructor(private readonly ledger: FiatLedgerService) {}

  /** Current internal-credit balance (replayed, source labelled). */
  @Get("balance")
  @UseGuards(JwtAuthGuard)
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.ledger.balance(user.pid);
  }

  /** Immutable journal export + replay verdict for the caller. */
  @Get("ledger")
  @UseGuards(JwtAuthGuard)
  statement(@CurrentUser() user: AuthenticatedUser) {
    return this.ledger.journal(user.pid);
  }

  /** Send step 1: inquiry only (moves no money). Phase-1 policy enforced. */
  @Post("transfers/inquiry")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  inquiry(@CurrentUser() user: AuthenticatedUser, @Body() dto: LedgerTransferInquiryDto) {
    return this.ledger.transferInquiry(user.pid, dto, dto.clientId);
  }

  /** Send step 2: posts all legs atomically. Idempotent on re-confirm. */
  @Post("transfers/:id/confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.ledger.transferConfirm(user.pid, id);
  }

  /** Cancel a created (not yet posted) intent. */
  @Post("transfers/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.ledger.cancelIntent(user.pid, id);
  }

  /** Admin: platform-wide replay projection + rail switches. */
  @Get("admin/replay")
  @UseGuards(JwtAuthGuard, AdminGuard)
  replay() {
    return this.ledger.adminReplay();
  }

  /** Admin: immutable journal export + replay verdict for one PID. */
  @Get("admin/journal/:pid")
  @UseGuards(JwtAuthGuard, AdminGuard)
  journal(@Param("pid") pid: string) {
    return this.ledger.journal(pid);
  }

  /** Admin: engage/clear the migration freeze (in-memory override, env is default). */
  @Post("admin/freeze")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  freeze(@Body() dto: LedgerFreezeDto) {
    this.ledger.setFrozenOverride(dto.frozen);
    return { frozen: this.ledger.ledgerFrozen(), reason: dto.reason ?? null };
  }

  /** Admin: verify the tamper-evident hash chain + expose the head hash. */
  @Get("admin/chain")
  @UseGuards(JwtAuthGuard, AdminGuard)
  verifyChain() {
    return this.ledger.verifyLedger();
  }

  /** Admin: current chain head (publish externally to make it tamper-proof). */
  @Get("admin/chain/head")
  @UseGuards(JwtAuthGuard, AdminGuard)
  chainHead() {
    return this.ledger.chainHead();
  }

  /** Admin: chain posted rows that predate the chain (idempotent repair). */
  @Post("admin/chain/backfill")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  chainBackfill() {
    return this.ledger.backfillChain();
  }

  /** Admin: deliver due third-party callbacks (cron-driven). */
  @Post("admin/dispatch-events")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  dispatchEvents(@Body() dto: DispatchEventsDto) {
    return this.ledger.dispatchEvents(dto);
  }

  /** Admin: inspect the callback outbox. */
  @Get("admin/events")
  @UseGuards(JwtAuthGuard, AdminGuard)
  events(@Query("status") status?: string) {
    return this.ledger.events(status);
  }
}
