// ANT-456 — admin System Settings API (contract-first, spec §5).
//
// Auth: JwtAuthGuard + AdminGuard (user session, role admin, status
// active; app/machine tokens rejected before any key lookup — no
// existence leak). Errors carry `{error, message}` with codes
// validation_error | not_found | version_conflict | unavailable.

import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { BackfillRunService } from "./backfill-run.service";
import { ListBackfillRunsQuery, ListSettingsQuery, RequestBackfillRunDto, SettingHistoryQuery, UpdateSettingDto } from "./settings.dto";
import { SettingsService } from "./settings.service";
import { XpSettingsService } from "./xp-settings.service";

@UseGuards(ThrottlerGuard)
@Controller("v1/admin/settings")
@UseGuards(JwtAuthGuard, AdminGuard)
export class SettingsAdminController {
  constructor(
    private readonly settings: SettingsService,
    private readonly xpSettings: XpSettingsService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async list(@Query() query: ListSettingsQuery) {
    return { settings: await this.settings.listSettings(query.prefix) };
  }

  // Static sub-paths must be declared before `:key` (Express matches in order).

  @Get("effective-intake")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async effectiveIntake(@Query("appId") appId?: string) {
    const result = await this.xpSettings.effectiveIntake(appId || undefined);
    return { effectiveIntake: result.allowed, breakdown: { ...result.breakdown, source: result.source } };
  }

  @Get(":key/history")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async history(@Param("key") key: string, @Query() query: SettingHistoryQuery) {
    return this.settings.settingHistory(key, { limit: query.limit, cursor: query.cursor });
  }

  @Get(":key")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getOne(@Param("key") key: string) {
    const setting = await this.settings.getSetting(key);
    if (!setting) throw new NotFoundException({ error: "not_found", message: `unknown setting key ${JSON.stringify(key)}` });
    return setting;
  }

  @Put(":key")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async update(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateSettingDto) {
    return this.settings.updateSetting(key, dto.value, {
      reason: dto.reason,
      expectedVersion: dto.expectedVersion,
      updatedBy: user.pid,
    });
  }
}

@UseGuards(ThrottlerGuard)
@Controller("v1/admin/xp/backfill")
@UseGuards(JwtAuthGuard, AdminGuard)
export class BackfillRunController {
  constructor(private readonly runs: BackfillRunService) {}

  @Post("run")
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async requestRun(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestBackfillRunDto) {
    return this.runs.requestRun(user.pid, {
      dryRun: dto.dryRun,
      policyVersion: dto.policyVersion,
      cursor: dto.cursor,
      batchSize: dto.batchSize,
    });
  }

  @Get("runs")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async listRuns(@Query() query: ListBackfillRunsQuery) {
    return this.runs.listRuns(query.limit ?? 20);
  }
}
