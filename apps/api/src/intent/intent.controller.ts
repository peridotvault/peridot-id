import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateIntentDto, RecordTransactionDto } from "./dto/intent.dto";
import { IntentService, IntentView, TransactionView } from "./intent.service";

@Controller("v1/wallet")
@UseGuards(ThrottlerGuard)
export class IntentController {
  constructor(private readonly intentService: IntentService) {}

  @Post("intents")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  createIntent(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIntentDto): Promise<IntentView> {
    return this.intentService.createIntent(user.identityId, { type: dto.type, payload: dto.payload as never });
  }

  @Get("intents/:id")
  @UseGuards(JwtAuthGuard)
  getIntent(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<IntentView> {
    return this.intentService.getIntent(user.identityId, id);
  }

  @Post("transactions/submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  recordTransaction(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordTransactionDto): Promise<TransactionView> {
    return this.intentService.recordTransaction(user.identityId, dto);
  }

  @Get("transactions/:id")
  @UseGuards(JwtAuthGuard)
  getTransaction(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<TransactionView> {
    return this.intentService.getTransaction(user.identityId, id);
  }
}