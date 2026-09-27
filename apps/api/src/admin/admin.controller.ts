import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateChainDto, UpdateChainDto, UpsertContractDto, VerifyAppDto } from "./admin.dto";
import { AdminService } from "./admin.service";

@UseGuards(ThrottlerGuard)
@Controller("v1/admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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
  listAllApps(@Query("clientId") clientId?: string, @Query("q") q?: string) {
    // Exact lookup mode for the verify workflow; substring search; else everything.
    if (clientId) return this.adminService.findAppByClientId(clientId);
    return this.adminService.listAllApps(q);
  }
}
