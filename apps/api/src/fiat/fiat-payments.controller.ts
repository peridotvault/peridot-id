import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreatePaymentDto, ListPaymentsDto, PaymentQuoteDto, RefundPaymentDto } from "./dto/payment.dto";
import { FiatPaymentsService } from "./fiat-payments.service";
@Controller("v1/fiat/payments")
@UseGuards(ThrottlerGuard, JwtAuthGuard)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class FiatPaymentsController {
  constructor(private readonly payments: FiatPaymentsService) {}
  @Post() @HttpCode(200)
  create(@CurrentUser() u: AuthenticatedUser, @Body() d: CreatePaymentDto) { return this.payments.create(u, d); }
  @Post("quote") @HttpCode(200)
  quote(@CurrentUser() u: AuthenticatedUser, @Body() d: PaymentQuoteDto) { return this.payments.quote(u, d); }
  @Get()
  list(@CurrentUser() u: AuthenticatedUser, @Query() q: ListPaymentsDto) { return this.payments.list(u, q); }
  @Get(":id")
  get(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) { return this.payments.get(u, id); }
  @Post(":id/cancel") @HttpCode(200)
  cancel(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) { return this.payments.cancel(u, id); }
  @Post(":id/refund") @HttpCode(200)
  refund(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() d: RefundPaymentDto) { return this.payments.refund(u, id, d); }
}
