import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateWalletDto } from "./dto/create-wallet.dto";
import { SponsoredWithdrawDto, SponsoredWithdrawResult, WithdrawQuoteDto } from "./dto/sponsored-withdraw.dto";
import { SponsoredWithdrawService, WithdrawQuote } from "./sponsored-withdraw.service";
import { WalletService, WalletView } from "./wallet.service";

@Controller("v1/wallet")
@UseGuards(ThrottlerGuard)
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly sponsoredWithdrawService: SponsoredWithdrawService,
  ) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<WalletView> {
    return this.walletService.getMe(user.identityId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWalletDto): Promise<WalletView> {
    return this.walletService.create(user.identityId, dto.address);
  }

  /** Fair relay fee (network fee × (1 + margin)) + chain time for the client to sign. */
  @Post("withdraw/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: WithdrawQuoteDto): Promise<WithdrawQuote> {
    void dto;
    return this.sponsoredWithdrawService.quote(user.identityId);
  }

  /** Relayer-sponsored withdraw: the SDK signs a passkey assertion; Peridot's relayer pays the fee. */
  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: SponsoredWithdrawDto): Promise<SponsoredWithdrawResult> {
    return this.sponsoredWithdrawService.withdraw(user.identityId, {
      asset: dto.asset,
      to: dto.to,
      amount: dto.amount,
      nonce: dto.nonce,
      expiry: dto.expiry,
      relayFeeLamports: dto.relayFeeLamports,
      assertion: dto.assertion as never,
    });
  }
}
