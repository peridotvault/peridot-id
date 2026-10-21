import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { CHAIN_REFERENCE_HEADER, CHAIN_REFERENCE_QUERY } from "../common/chains";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { CreateIntentDto, RecordActivityDto, RecordTransactionDto } from "./dto/intent.dto";
import { IntentService, IntentView, TransactionView } from "./intent.service";

@Controller("v1/wallet")
@UseGuards(ThrottlerGuard)
export class IntentController {
  constructor(
    private readonly intentService: IntentService,
    private readonly chains: ChainRegistryService,
  ) {}

  /**
   * Network selection for this request (ANT-15 spec §8): the
   * `X-Chain-Reference` header wins, `?chainReference` is the GET-friendly
   * fallback. Absent = server default (current behavior); unknown = 400
   * UNKNOWN_CHAIN, fail-closed before any chain write.
   */
  private selection(chainRefHeader?: string, chainRefQuery?: string | string[]) {
    return this.chains.selectionFromReferenceOrThrow(chainRefHeader ?? chainRefQuery);
  }

  @Post("intents")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async createIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateIntentDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<IntentView> {
    return this.intentService.createIntent(
      user.pid,
      { type: dto.type, payload: dto.payload as never },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }

  @Get("intents/:id")
  @UseGuards(JwtAuthGuard)
  getIntent(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<IntentView> {
    return this.intentService.getIntent(user.pid, id);
  }

  @Post("transactions/submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  recordTransaction(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordTransactionDto): Promise<TransactionView> {
    return this.intentService.recordTransaction(user.pid, dto);
  }

  @Post("transactions")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async recordActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecordActivityDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<TransactionView> {
    return this.intentService.recordActivity(
      user.pid,
      {
        type: dto.type,
        amount: dto.amount,
        asset: dto.asset,
        direction: dto.direction,
        counterparty: dto.counterparty,
        txHash: dto.txHash,
      },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }

  @Get("transactions/:id")
  @UseGuards(JwtAuthGuard)
  getTransaction(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<TransactionView> {
    return this.intentService.getTransaction(user.pid, id);
  }

  @Get("transactions")
  @UseGuards(JwtAuthGuard)
  listTransactions(@CurrentUser() user: AuthenticatedUser): Promise<TransactionView[]> {
    return this.intentService.listTransactions(user.pid);
  }
}