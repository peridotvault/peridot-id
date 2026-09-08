import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { PidAppsService } from "./apps.service";
import { CreatePidAppDto, UpdatePidAppDto } from "./dto/app.dto";

@Controller("v1/apps")
@UseGuards(ThrottlerGuard, JwtAuthGuard)
export class PidAppsController {
  constructor(private readonly apps: PidAppsService) {}

  /** Register a third-party app and get its public client_id. Origins managed after. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePidAppDto) {
    return this.apps.create(user.identityId, dto.name, dto.allowedOrigins ?? []);
  }

  /** List my registered apps. */
  @Get()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.apps.list(user.identityId);
  }

  /** Rename, change redirect URIs, or disable one of my apps. */
  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePidAppDto,
  ) {
    return this.apps.update(user.identityId, id, dto);
  }

  /**
   * Generate (or rotate) an app's backend secret for confidential clients.
   * The plaintext is returned ONCE — store it server-side, never in frontend code.
   */
  @Post(":id/secret")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  rotateSecret(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.apps.rotateSecret(user.identityId, id);
  }
}
