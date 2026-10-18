import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { CHAIN_REFERENCE_HEADER, CHAIN_REFERENCE_QUERY } from "../common/chains";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateWalletDto } from "./dto/create-wallet.dto";
import { RotateAuthorityDto, RotateAuthorityResult } from "./dto/rotate.dto";
import { RotateService } from "./rotate.service";
import { SponsoredWithdrawDto, SponsoredWithdrawResult, WithdrawQuoteDto } from "./dto/sponsored-withdraw.dto";
import { ExecuteQuoteDto, SponsoredExecuteDto } from "./dto/execute.dto";
import { SponsoredWithdrawService, WithdrawQuote } from "./sponsored-withdraw.service";
import { WalletService, WalletView } from "./wallet.service";

@Controller("v1/wallet")
@UseGuards(ThrottlerGuard)
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly sponsoredWithdrawService: SponsoredWithdrawService,
    private readonly rotateService: RotateService,
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

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<WalletView> {
    return this.walletService.getMe(user.pid);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWalletDto): Promise<WalletView> {
    return this.walletService.create(user.pid, dto.address);
  }

  /** Attested fee + policy + chain time for the client to sign a maxFee-capped authorization. */
  @Post("withdraw/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WithdrawQuoteDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<WithdrawQuote> {
    void dto;
    return this.sponsoredWithdrawService.quote(user.pid, await this.selection(chainRefHeader, chainRefQuery));
  }

  /** Relayer-sponsored withdraw (V3): the SDK signs intent + fee policy; Peridot's relayer pays the fee. */
  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SponsoredWithdrawDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<SponsoredWithdrawResult> {
    return this.sponsoredWithdrawService.withdraw(
      user.pid,
      {
        asset: dto.asset,
        to: dto.to,
        amount: dto.amount,
        nonce: dto.nonce,
        expiry: dto.expiry,
        feePolicyVersion: dto.feePolicyVersion,
        quotedNetworkFeeLamports: dto.quotedNetworkFeeLamports,
        assertion: dto.assertion as never,
      },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }

  /** Relayer-sponsored generic execute (V3): the SDK signs call_hash + fee policy; Peridot's relayer pays the fee. */
  @Post("execute")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async execute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SponsoredExecuteDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<SponsoredWithdrawResult> {
    return this.sponsoredWithdrawService.execute(
      user.pid,
      {
        target: dto.target,
        metas: dto.metas,
        data: dto.data,
        nonce: dto.nonce,
        expiry: dto.expiry,
        feePolicyVersion: dto.feePolicyVersion,
        quotedNetworkFeeLamports: dto.quotedNetworkFeeLamports,
        assertion: dto.assertion as never,
      },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }

  /** Attested fee + policy + chain time for the client to sign an execute authorization. */
  @Post("execute/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async executeQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ExecuteQuoteDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<WithdrawQuote> {
    return this.sponsoredWithdrawService.quoteExecute(
      user.pid,
      {
        target: dto.target,
        metas: dto.metas,
        data: dto.data,
      },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }

  /**
   * Credential lifecycle rotation (V2): register the replacement credential first
   * (existing approval flow), then the current key authorizes on-chain
   * `update_authority` here. The old credential is revoked in DB only after the
   * chain confirms the new authority — DB authority ⊆ chain authority always.
   */
  @Post("rotate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  async rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RotateAuthorityDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<RotateAuthorityResult> {
    return this.rotateService.rotate(
      user.pid,
      {
        oldCredentialId: dto.oldCredentialId,
        newCredentialId: dto.newCredentialId,
        nonce: dto.nonce,
        expiry: dto.expiry,
        assertion: dto.assertion as never,
      },
      await this.selection(chainRefHeader, chainRefQuery),
    );
  }
}
