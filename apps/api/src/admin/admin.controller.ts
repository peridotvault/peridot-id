import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CreateChainDto, UpdateChainDto, UpsertContractDto } from "./admin.dto";
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
    return this.adminService.createChain(user.identityId, dto);
  }

  @Patch("chains/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  updateChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateChainDto,
  ) {
    return this.adminService.updateChain(user.identityId, id, dto);
  }

  @Post("chains/:id/contracts")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(JwtAuthGuard, AdminGuard)
  upsertContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertContractDto,
  ) {
    return this.adminService.upsertContract(user.identityId, id, dto);
  }
}
