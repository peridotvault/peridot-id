import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { PidAppsService } from "./apps.service";
import { CreatePidAppDto, SetAppFeeDto, SetWebhookDto, UpdatePidAppDto } from "./dto/app.dto";

@Controller("v1/apps")
@UseGuards(ThrottlerGuard, JwtAuthGuard)
export class PidAppsController {
  constructor(private readonly apps: PidAppsService) {}

  /** Register a third-party app and get its public client_id. Origins managed after. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePidAppDto) {
    return this.apps.create(user.pid, dto.name, dto.allowedOrigins ?? []);
  }

  /** List my registered apps. */
  @Get()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.apps.list(user.pid);
  }

  /** One owned app (404 unless the caller owns it). */
  @Get(":id")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  get(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.apps.get(user.pid, id);
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
    return this.apps.update(user.pid, id, dto);
  }

  /**
   * Generate (or rotate) an app's backend secret for confidential clients.
   * The plaintext is returned ONCE — store it server-side, never in frontend code.
   */
  @Post(":id/secret")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  rotateSecret(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.apps.rotateSecret(user.pid, id);
  }

  /** Set the ledger-callback endpoint; returns the HMAC signing secret ONCE. */
  @Post(":id/webhook")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  setWebhook(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string, @Body() dto: SetWebhookDto) {
    return this.apps.setWebhook(user.pid, id, dto.url);
  }

  /** Remove the ledger-callback endpoint (and its signing secret). */
  @Delete(":id/webhook")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  clearWebhook(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.apps.setWebhook(user.pid, id, null);
  }

  /** Per-app fee schedule (topup / transaction / withdraw). Owner only. */
  @Get(":id/fees")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  listFees(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.apps.listFees(user.pid, id);
  }

  /** Set one operation's per-app fee (stacks on the global fee). */
  @Put(":id/fees/:operation")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  setFee(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("operation") operation: string,
    @Body() dto: SetAppFeeDto,
  ) {
    return this.apps.setFee(user.pid, id, operation, dto);
  }
}
