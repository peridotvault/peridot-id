import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { CHAIN_REFERENCE_HEADER, CHAIN_REFERENCE_QUERY } from "../common/chains";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { ActivationService, ActivationView } from "./activation.service";
import { AccountService, ChainAccountView } from "./account.service";
import { EvmActivationService, EvmActivationView, EvmFirstActionResult } from "./evm-activation.service";
import { ActivateDto } from "./dto/activate.dto";
import { EvmActivateDto } from "./dto/evm-activate.dto";
import { EvmFirstActionDto } from "./dto/evm-first-action.dto";

// 1 identity = 1 personal wallet. No account ids anywhere — the owner
// always comes from the JWT, the wallet is resolved from it.
@Controller("v1/account")
@UseGuards(ThrottlerGuard)
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly activationService: ActivationService,
    private readonly evmActivationService: EvmActivationService,
    private readonly chainRegistry: ChainRegistryService,
  ) {}

  /**
   * Network selection for this request (ANT-15 spec §8): the
   * `X-Chain-Reference` header wins, `?chainReference` is the GET-friendly
   * fallback. Absent = server default (current behavior); unknown = 400
   * UNKNOWN_CHAIN, fail-closed before any chain write.
   */
  private selection(chainRefHeader?: string, chainRefQuery?: string | string[]) {
    return this.chainRegistry.selectionFromReferenceOrThrow(chainRefHeader ?? chainRefQuery);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<ChainAccountView[]> {
    return this.accountService.ensureAccount(user.pid, await this.selection(chainRefHeader, chainRefQuery));
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
  async activation(
    @CurrentUser() user: AuthenticatedUser,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<ActivationView> {
    return this.activationService.viewOf(user, await this.selection(chainRefHeader, chainRefQuery));
  }

  @Post("activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  async activate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ActivateDto,
    @Headers(CHAIN_REFERENCE_HEADER) chainRefHeader?: string,
    @Query(CHAIN_REFERENCE_QUERY) chainRefQuery?: string | string[],
  ): Promise<ActivationView> {
    return this.activationService.activate(user, dto, await this.selection(chainRefHeader, chainRefQuery));
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
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  evmActivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chainRef") chainRef: string,
    @Body() dto: EvmActivateDto,
  ): Promise<EvmActivationView> {
    return this.evmActivationService.activate(user, chainRef, dto);
  }

  /**
   * WS1 §3.1 lazy first-action (EVM): one approval runs `deployAndInit` →
   * `execute` back-to-back through the relayer. Idempotent on `firstActionId`
   * (in-flight → `ActivationInProgress` 409; completed → same hashes, no
   * second deploy or execute). Returns the activation view + execute hash.
   */
  @Post("evm/:chainRef/first-action")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, UserTokenGuard)
  evmFirstAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chainRef") chainRef: string,
    @Body() dto: EvmFirstActionDto,
  ): Promise<EvmFirstActionResult> {
    return this.evmActivationService.activateAndExecute(user, chainRef, dto);
  }
}
