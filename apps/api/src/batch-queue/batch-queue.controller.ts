import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { CHAIN_REFERENCE_HEADER, CHAIN_REFERENCE_QUERY } from "../common/chains";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { BatchQueueService, BatchMetrics, BatchQuoteView, BatchStatusView } from "./batch-queue.service";
import { EstimateBatchDto, SubmitBatchDto } from "./dto/batch.dto";

/**
 * Phase-1a intent queue (ANT-762). EVM op shapes (to/value/data) adapted from
 * ERC-5792 call objects; transport is relayer-executed sequential
 * single-calls, NOT EIP-4337-bundled (no bundler/paymaster exists).
 */
@Controller("v1/wallet/execute/batch")
@UseGuards(ThrottlerGuard)
export class BatchQueueController {
  constructor(
    private readonly batches: BatchQueueService,
    private readonly chains: ChainRegistryService,
  ) {}

  private selection(chainRefHeader?: string, chainRefQuery?: string | string[]) {
    return this.chains.selectionFromReferenceOrThrow(chainRefHeader ?? chainRefQuery);
  }

  /** Locked pass-through quote for a batch (quoteId binds the exact op list). */
  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EstimateBatchDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<BatchQuoteView> {
    void this.selection(chainRefHeader, chainRefQuery);
    return this.batches.estimateBatch(user.pid, dto);
  }

  /** Submit a batch: enqueue for the timed flush, or settle now with bypassQueue. */
  @Post("submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitBatchDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<BatchStatusView> {
    void this.selection(chainRefHeader, chainRefQuery);
    return this.batches.submitBatch(user.pid, dto);
  }

  /** Flush due batches (ops/cron driver — no in-process timers by design). */
  @Post("flush")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  flush(@CurrentUser() user: AuthenticatedUser): Promise<BatchStatusView[]> {
    void user;
    return this.batches.flushDueBatches();
  }

  /** Phase-1b go/no-go metrics (batch/fill/S/failure-revert rates). */
  @Get("metrics/summary")
  @UseGuards(JwtAuthGuard)
  metrics(@Query("days") days?: string): Promise<BatchMetrics> {
    const n = days === undefined ? 7 : Number.parseInt(days, 10);
    return this.batches.batchMetrics(n);
  }

  /** Batch lifecycle + per-op results + fee settlement (ERC-5792-adapted status). */
  @Get(":id")
  @UseGuards(JwtAuthGuard)
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<BatchStatusView> {
    return this.batches.getBatchStatus(user.pid, id);
  }

  /** Cancel a queued batch (queued only — settles to expired, fee-free). */
  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<BatchStatusView> {
    return this.batches.cancelQueuedBatch(user.pid, id);
  }
}
