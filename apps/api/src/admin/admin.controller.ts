import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CloseBreakerDto, CloseRelayerBreakerDto, CreateChainDto, CreateFeePolicyDto, CreateTokenDto, OpenRelayerBreakerDto, PreviewChainDto, PreviewTokenDto, SetEvmRelayerDto, UpdateChainDto, UpdateTokenDeploymentDto, UpdateTokenDto, UpsertContractDto, VerifyAppDto } from "./admin.dto";
import { AdminService } from "./admin.service";
import { ChainPreviewService } from "./chain-preview.service";
import { CircuitBreakerService } from "../relayer/circuit-breaker.service";
import { TokenPreviewService } from "./token-preview.service";

@UseGuards(ThrottlerGuard)
@Controller("v1/admin")
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly preview: TokenPreviewService,
    private readonly chainPreview: ChainPreviewService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  @Get("chains")
  @UseGuards(JwtAuthGuard, AdminGuard)
  chains() {
    return this.adminService.listChains();
  }

  @Post("chains")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  createChain(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateChainDto) {
    return this.adminService.createChain(user.pid, dto);
  }

  @Patch("chains/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  updateChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateChainDto,
  ) {
    return this.adminService.updateChain(user.pid, id, dto);
  }

  @Post("chains/:id/contracts")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  upsertContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertContractDto,
  ) {
    return this.adminService.upsertContract(user.pid, id, dto);
  }

  @Put("chains/:id/evm-relayer")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  setEvmRelayer(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetEvmRelayerDto,
  ) {
    return this.adminService.setEvmRelayer(user.pid, id, dto.secret);
  }

  @Delete("chains/:id/evm-relayer")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  deleteEvmRelayer(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminService.deleteEvmRelayer(user.pid, id);
  }

  /** F3: operator-only spend-rate breaker observability (admin JWT, never app tokens). */
  @Get("relayer/breaker")
  @UseGuards(JwtAuthGuard, AdminGuard)
  breakerSnapshot(@Query("chain") chain: string) {
    if (!chain) throw new BadRequestException("chain query is required");
    return this.breaker.snapshot(chain);
  }

  /** F3: manual breaker resume (runbook §H4.4) — evidence required and logged. */
  @Post("relayer/breaker/close")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  closeBreaker(@CurrentUser() user: AuthenticatedUser, @Body() dto: CloseBreakerDto) {
    return this.breaker.closeBreaker(user.pid, dto.chain, dto.evidence);
  }

  /** H3 freeze path (runbook §2/§3): manually open the breaker with a reason. */
  @Post("relayer-breaker/:chain/open")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  openRelayerBreaker(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chain") chain: string,
    @Body() dto: OpenRelayerBreakerDto,
  ) {
    return this.adminService.openRelayerBreaker(user.pid, chain, dto.reason);
  }

  /** H3 resume path (runbook §4) via the admin service (adds the admin audit row). */
  @Post("relayer-breaker/:chain/close")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  closeRelayerBreaker(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chain") chain: string,
    @Body() dto: CloseRelayerBreakerDto,
  ) {
    return this.adminService.closeRelayerBreaker(user.pid, chain, dto.evidence);
  }

  @Post("chains/:id/logo")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor("logo", { limits: { fileSize: 512 * 1024 } }))
  setChainLogo(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ) {
    if (!file?.buffer) throw new BadRequestException("logo file required (field: logo)");
    return this.adminService.setChainLogo(user.pid, id, file);
  }

  @Patch("apps/:id/verify")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  setAppVerified(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: VerifyAppDto,
  ) {
    return this.adminService.setAppVerified(user.pid, id, dto.verified);
  }

  @Get("apps")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  listAllApps(
    @Query("clientId") clientId?: string,
    @Query("q") q?: string,
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
    @Query("offset", new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    // Exact lookup mode for the verify workflow; substring search; else everything.
    if (clientId) return this.adminService.findAppByClientId(clientId);
    return this.adminService.listAllApps(q, limit, offset);
  }

  @Get("tokens")
  @UseGuards(JwtAuthGuard, AdminGuard)
  tokens() {
    return this.adminService.listTokens();
  }

  @Post("chains/preview")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  previewChain(@Body() dto: PreviewChainDto) {
    return this.chainPreview.preview(dto.chainNamespace, dto.reference, dto.rpcUrl);
  }

  @Post("tokens/preview")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  previewToken(@Body() dto: PreviewTokenDto) {
    return this.preview.preview(dto.chainNamespace, dto.chainReference, dto.mint);
  }

  @Post("tokens")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  createToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTokenDto) {
    return this.adminService.createToken(user.pid, dto);
  }

  @Patch("tokens/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  updateToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTokenDto,
  ) {
    return this.adminService.updateToken(user.pid, id, dto);
  }

  @Patch("tokens/deployments/:deploymentId")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  updateTokenDeployment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
    @Body() dto: UpdateTokenDeploymentDto,
  ) {
    return this.adminService.updateTokenDeployment(user.pid, deploymentId, dto);
  }

  @Post("tokens/:id/logo")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor("logo", { limits: { fileSize: 512 * 1024 } }))
  setTokenLogo(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ) {
    if (!file?.buffer) throw new BadRequestException("logo file required (field: logo)");
    return this.adminService.setTokenLogo(user.pid, id, file);
  }

  // --- Chain fee-policy (ANT-730, ANT-743 pure percentage, minima ignored) ---

  /** Every fee-policy version, newest first (minima always empty). */
  @Get("fee-policies")
  @UseGuards(JwtAuthGuard, AdminGuard)
  feePolicies() {
    return this.adminService.listFeePolicies();
  }

  /** Publish a new (inactive) policy version. Published rows are never mutated. */
  @Post("fee-policies")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  createFeePolicy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFeePolicyDto) {
    return this.adminService.createFeePolicy(user.pid, dto);
  }

  /** Activate one version (fresh quotes pick it up within the 30s cache TTL). */
  @Post("fee-policies/:version/activate")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  activateFeePolicy(@CurrentUser() user: AuthenticatedUser, @Param("version", ParseIntPipe) version: number) {
    return this.adminService.activateFeePolicy(user.pid, version);
  }

  /** Daily quote-vs-actual aggregates for the internal subsidy dashboard (NFR-4). */
  @Get("subsidy-ledger/summary")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  subsidySummary(@Query("days", new ParseIntPipe({ optional: true })) days?: number) {
    return this.adminService.subsidyDailySummary(days);
  }
}
