import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { AuthenticatedUser, CurrentUser } from "../common/current-user.decorator";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { UserTokenGuard } from "../common/user-token.guard";
import { CreateAppXpTaskDto, UpdateAppXpTaskDto } from "./app-xp-task.dto";
import { ExperienceTasksService } from "./experience-tasks.service";

/**
 * Self-serve XP tasks for verified app owners (ANT app XP).
 *
 * The owner defines which events their app awards XP for and how much. Server
 * forces scope = this app, checker = backend_check.app_attested, status active,
 * recurring unlimited, and no per-period caps. XP is cosmetic progression
 * only — never money. Abuse levers stay platform-side: verified-app gate,
 * idempotent intake, reversals, suspend.
 */
@Controller("v1/apps/:id/xp-tasks")
@UseGuards(ThrottlerGuard, JwtAuthGuard)
export class AppXpTasksController {
  constructor(private readonly tasks: ExperienceTasksService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseGuards(UserTokenGuard)
  list(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.tasks.listAppTasks(user.pid, id);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseGuards(UserTokenGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateAppXpTaskDto,
  ) {
    return this.tasks.createAppTask(user.pid, id, dto);
  }

  @Patch(":taskId")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseGuards(UserTokenGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: UpdateAppXpTaskDto,
  ) {
    return this.tasks.updateAppTask(user.pid, id, taskId, dto);
  }
}
