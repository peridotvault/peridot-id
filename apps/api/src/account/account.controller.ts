import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { AccountService, AccountView, ChainAccountView } from "./account.service";

@Controller("v1/accounts")
@UseGuards(ThrottlerGuard)
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthenticatedUser): Promise<AccountView> {
    return this.accountService.createAccount(user.identityId);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: AuthenticatedUser): Promise<AccountView[]> {
    return this.accountService.getAccounts(user.identityId);
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard)
  get(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<AccountView> {
    return this.accountService.getAccount(user.identityId, id);
  }

  @Get(":id/chains")
  @UseGuards(JwtAuthGuard)
  chains(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<ChainAccountView[]> {
    return this.accountService.getAccountChains(user.identityId, id);
  }
}