import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateWalletDto } from "./dto/create-wallet.dto";
import { WalletService, WalletView } from "./wallet.service";

@Controller("v1/wallet")
@UseGuards(ThrottlerGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
}
