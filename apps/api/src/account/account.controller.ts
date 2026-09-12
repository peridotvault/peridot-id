import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { ActivationService, ActivationView } from "./activation.service";
import { AccountService, AccountView, ChainAccountView } from "./account.service";
import { EvmActivationService, EvmActivationView } from "./evm-activation.service";

@Controller("v1/accounts")
@UseGuards(ThrottlerGuard)
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly activationService: ActivationService,
    private readonly evmActivationService: EvmActivationService,
  ) {}

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

  @Get(":id/activation")
  @UseGuards(JwtAuthGuard)
  activation(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<ActivationView> {
    return this.activationService.viewOf(user, id);
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  activate(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<ActivationView> {
    return this.activationService.activate(user, id);
  }

  @Get(":id/evm/:chainRef/activation")
  @UseGuards(JwtAuthGuard)
  evmActivation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("chainRef") chainRef: string,
  ): Promise<EvmActivationView> {
    return this.evmActivationService.viewOf(user, id, chainRef);
  }

  @Post(":id/evm/:chainRef/activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  evmActivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("chainRef") chainRef: string,
  ): Promise<EvmActivationView> {
    return this.evmActivationService.activate(user, id, chainRef);
  }
}