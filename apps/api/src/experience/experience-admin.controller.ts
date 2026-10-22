import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AdminGuard } from "../common/admin.guard";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import {
  ActivatePolicyDto,
  AdjustXpDto,
  CreatePolicyDto,
  CreateTaskDto,
  MaterializePolicyDto,
  ReviewSuspiciousDto,
  SetXpPermissionDto,
  SuspendAppDto,
  UpdateTaskDto,
  UpsertQuotaDto,
  ReverseXpDto,
} from "./experience-admin.dto";
import { ExperienceAdminService } from "./experience-admin.service";

/**
 * ANT-89 M2 — admin experience API (dashboard-backed).
 *
 * Every route requires JwtAuthGuard + AdminGuard. AdminGuard rejects machine
 * (app) tokens even for admin owners — XP permission grants, quota changes,
 * adjustments, and reversals are therefore never enforceable by app-token or
 * client-side alone (Tobias F3/F4). No bulk-adjust endpoint ships here (F4).
 */
@UseGuards(ThrottlerGuard)
@Controller("v1/admin/experience")
@UseGuards(JwtAuthGuard, AdminGuard)
export class ExperienceAdminController {
  constructor(private readonly xpAdmin: ExperienceAdminService) {}

  // -- policy versions (R4 flow up to activation) --------------------------

  @Get("policies")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  listPolicies() {
    return this.xpAdmin.listPolicies();
  }

  @Post("policies")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  createPolicy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePolicyDto) {
    return this.xpAdmin.createPolicyDraft(user.pid, dto);
  }

  @Post("policies/:id/materialize")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  materializePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: MaterializePolicyDto,
  ) {
    return this.xpAdmin.materializePolicy(user.pid, id, dto);
  }

  @Get("policies/:id/preview")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  previewPolicy(@Param("id", ParseUUIDPipe) id: string) {
    return this.xpAdmin.previewPolicy(id);
  }

  @Post("policies/:id/activate")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  activatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ActivatePolicyDto,
  ) {
    return this.xpAdmin.activatePolicy(user.pid, id, dto);
  }

  // -- tasks CRUD + lifecycle (F8 activation refusal) -----------------------

  @Post("tasks")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  createTask(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.xpAdmin.createTask(user.pid, dto);
  }

  @Get("tasks")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  listTasks(@Query("status") status?: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    return this.xpAdmin.listTasks({
      status,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Get("tasks/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  getTask(@Param("id", ParseUUIDPipe) id: string) {
    return this.xpAdmin.getTask(id);
  }

  @Patch("tasks/:id")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  updateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.xpAdmin.updateTask(user.pid, id, dto as Record<string, unknown>);
  }

  // -- verification / XP permission (C3 + F3) --------------------------------

  @Put("apps/:id/xp-permission")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  setXpPermission(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetXpPermissionDto,
  ) {
    return this.xpAdmin.setXpPermission(user.pid, id, dto);
  }

  // -- quotas + suspend -------------------------------------------------------

  @Put("apps/:id/quota")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  upsertQuota(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertQuotaDto,
  ) {
    return this.xpAdmin.upsertQuota(user.pid, id, dto);
  }

  @Put("org-quotas/:ownerPid")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  upsertOrgQuota(
    @CurrentUser() user: AuthenticatedUser,
    @Param("ownerPid") ownerPid: string,
    @Body() dto: UpsertQuotaDto,
  ) {
    return this.xpAdmin.upsertOrgQuota(user.pid, ownerPid, dto);
  }

  @Patch("apps/:id/suspend")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  suspendApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SuspendAppDto,
  ) {
    return this.xpAdmin.suspendApp(user.pid, id, dto);
  }

  // -- adjustments + reversals (F4; W1 reversals are new negative entries) -----

  @Post("adjustments")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  adjust(@CurrentUser() user: AuthenticatedUser, @Body() dto: AdjustXpDto) {
    return this.xpAdmin.adjust(user.pid, dto);
  }

  @Post("reversals")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  reverse(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReverseXpDto) {
    return this.xpAdmin.reverse(user.pid, dto);
  }

  // -- reads: history, suspicious review, overview -----------------------------

  @Get("ledger")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  ledger(
    @Query("pid") pid?: string,
    @Query("kind") kind?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.xpAdmin.ledgerHistory({
      pid,
      kind,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Get("suspicious")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  suspicious(
    @Query("reviewed") reviewed?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.xpAdmin.listSuspicious({
      reviewed: reviewed === undefined ? undefined : reviewed === "true",
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Patch("suspicious/:id/review")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  reviewSuspicious(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviewSuspiciousDto,
  ) {
    return this.xpAdmin.reviewSuspicious(user.pid, id, dto);
  }

  @Get("overview")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  overview() {
    return this.xpAdmin.overview();
  }
}
