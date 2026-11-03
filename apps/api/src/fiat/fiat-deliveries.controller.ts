import { Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { FiatLedgerEventsService } from "./fiat-ledger-events.service";
@Controller("v1/apps/:id/webhook/deliveries")
@UseGuards(ThrottlerGuard, JwtAuthGuard, UserTokenGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class FiatDeliveriesController {
  constructor(private readonly events: FiatLedgerEventsService) {}
  @Get()
  list(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) { return this.events.deliveries(u.pid, id); }
  @Post(":eventId/replay") @HttpCode(200)
  replay(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Param("eventId") eventId: string) { return this.events.replay(u.pid, id, eventId); }
}
