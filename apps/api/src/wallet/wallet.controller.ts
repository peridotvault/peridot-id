import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
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
  ) {}

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
  quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: WithdrawQuoteDto): Promise<WithdrawQuote> {
    void dto;
    return this.sponsoredWithdrawService.quote(user.pid);
  }

  /** Relayer-sponsored withdraw (V3): the SDK signs intent + fee policy; Peridot's relayer pays the fee. */
  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: SponsoredWithdrawDto): Promise<SponsoredWithdrawResult> {
    return this.sponsoredWithdrawService.withdraw(user.pid, {
      asset: dto.asset,
      to: dto.to,
      amount: dto.amount,
      nonce: dto.nonce,
      expiry: dto.expiry,
      feePolicyVersion: dto.feePolicyVersion,
      quotedNetworkFeeLamports: dto.quotedNetworkFeeLamports,
      assertion: dto.assertion as never,
    });
  }

  /** Relayer-sponsored generic execute (V3): the SDK signs call_hash + fee policy; Peridot's relayer pays the fee. */
  @Post("execute")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  execute(@CurrentUser() user: AuthenticatedUser, @Body() dto: SponsoredExecuteDto): Promise<SponsoredWithdrawResult> {
    return this.sponsoredWithdrawService.execute(user.pid, {
      target: dto.target,
      metas: dto.metas,
      data: dto.data,
      nonce: dto.nonce,
      expiry: dto.expiry,
      feePolicyVersion: dto.feePolicyVersion,
      quotedNetworkFeeLamports: dto.quotedNetworkFeeLamports,
      assertion: dto.assertion as never,
    });
  }

  /** Attested fee + policy + chain time for the client to sign an execute authorization. */
  @Post("execute/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  executeQuote(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExecuteQuoteDto): Promise<WithdrawQuote> {
    return this.sponsoredWithdrawService.quoteExecute(user.pid, {
      target: dto.target,
      metas: dto.metas,
      data: dto.data,
    });
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
  rotate(@CurrentUser() user: AuthenticatedUser, @Body() dto: RotateAuthorityDto): Promise<RotateAuthorityResult> {
    return this.rotateService.rotate(user.pid, {
      oldCredentialId: dto.oldCredentialId,
      newCredentialId: dto.newCredentialId,
      nonce: dto.nonce,
      expiry: dto.expiry,
      assertion: dto.assertion as never,
    });
  }
}
