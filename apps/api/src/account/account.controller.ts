import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { ActivationService, ActivationView } from "./activation.service";
import { AccountService, ChainAccountView } from "./account.service";
import { EvmActivationService, EvmActivationView } from "./evm-activation.service";

// ADR-008: 1 identity = 1 personal wallet. No account ids anywhere — the owner
// always comes from the JWT, the wallet is resolved from it.
@Controller("v1/account")
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
  create(@CurrentUser() user: AuthenticatedUser): Promise<ChainAccountView[]> {
    return this.accountService.ensureAccount(user.pid);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  get(@CurrentUser() user: AuthenticatedUser): Promise<ChainAccountView[]> {
    return this.accountService.getChains(user.pid);
  }

  @Get("chains")
  @UseGuards(JwtAuthGuard)
  chains(@CurrentUser() user: AuthenticatedUser): Promise<ChainAccountView[]> {
    return this.accountService.getChains(user.pid);
  }

  @Get("activation")
  @UseGuards(JwtAuthGuard)
  activation(@CurrentUser() user: AuthenticatedUser): Promise<ActivationView> {
    return this.activationService.viewOf(user);
  }

  @Post("activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  activate(@CurrentUser() user: AuthenticatedUser): Promise<ActivationView> {
    return this.activationService.activate(user);
  }

  @Get("evm/:chainRef/activation")
  @UseGuards(JwtAuthGuard)
  evmActivation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chainRef") chainRef: string,
  ): Promise<EvmActivationView> {
    return this.evmActivationService.viewOf(user, chainRef);
  }

  @Post("evm/:chainRef/activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  evmActivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chainRef") chainRef: string,
  ): Promise<EvmActivationView> {
    return this.evmActivationService.activate(user, chainRef);
  }
}
