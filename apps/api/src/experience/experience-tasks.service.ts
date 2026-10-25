import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { TASK_KEY_FORMAT, TASK_RECURRING, TASK_STATUSES, validateChecker } from "./catalog";
import { CreateTaskDto } from "./experience-admin.dto";
import { requireApp } from "./experience-admin-guards";

function validateTaskSemantics(input: {
  recurring?: string;
  lifetimeLimit?: number | null;
  dailyLimit?: number | null;
  weeklyLimit?: number | null;
  monthlyLimit?: number | null;
  availableFrom?: string | Date | null;
  availableUntil?: string | Date | null;
}): void {
  if (input.recurring !== undefined && !(TASK_RECURRING as readonly string[]).includes(input.recurring)) {
    throw new BadRequestException(`recurring must be one of ${(TASK_RECURRING as readonly string[]).join("|")}`);
  }
  if (input.availableFrom && input.availableUntil) {
    const from = new Date(input.availableFrom).getTime();
    const until = new Date(input.availableUntil).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(until)) throw new BadRequestException("invalid availability dates");
    if (from >= until) throw new BadRequestException("availableFrom must be before availableUntil");
  }
}
function sanitizeTaskKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (!TASK_KEY_FORMAT.test(k)) throw new BadRequestException("key must match ^[a-z][a-z0-9_]{2,63}$");
  return k;
}

const MAX_INT = 100000;

@Injectable()
export class ExperienceTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  async createTask(actorAdminId: string, dto: CreateTaskDto) {
    const key = sanitizeTaskKey(dto.key);
    validateTaskSemantics(dto);
    if (dto.scopeAppId) await requireApp(this.prisma, dto.scopeAppId);
    if (dto.verificationType !== undefined && !(["internal_state", "backend_check"] as string[]).includes(dto.verificationType)) {
      throw new BadRequestException("verificationType must be internal_state|backend_check");
    }
    try {
      const task = await this.prisma.xpTask.create({
        data: {
          key,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          xpReward: dto.xpReward,
          recurring: dto.recurring ?? "once",
          lifetimeLimit: dto.lifetimeLimit ?? null,
          dailyLimit: dto.dailyLimit ?? null,
          weeklyLimit: dto.weeklyLimit ?? null,
          monthlyLimit: dto.monthlyLimit ?? null,
          cooldownSecs: dto.cooldownSecs ?? null,
          availableFrom: dto.availableFrom ? new Date(dto.availableFrom) : null,
          availableUntil: dto.availableUntil ? new Date(dto.availableUntil) : null,
          verificationType: dto.verificationType ?? "internal_state",
          verificationChecker: dto.verificationChecker?.trim() || null,
          scopeAppId: dto.scopeAppId ?? null,
          createdBy: actorAdminId,
        },
      });
      await this.security.log(actorAdminId, "admin.xp.task.created", { taskId: task.id, key });
      return task;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("task key already exists");
      }
      throw e;
    }
  }

  async listTasks(query: { status?: string; limit?: number; offset?: number }) {
    if (query.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(query.status)) {
      throw new BadRequestException(`status must be one of ${(TASK_STATUSES as readonly string[]).join("|")}`);
    }
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Math.floor(query.offset ?? 0) || 0, 0);
    const [rows, total] = await Promise.all([
      this.prisma.xpTask.findMany({
        where: query.status ? { status: query.status } : undefined,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset || undefined,
      }),
      this.prisma.xpTask.count({ where: query.status ? { status: query.status } : undefined }),
    ]);
    return { rows, total, limit, offset };
  }

  async getTask(id: string) {
    const task = await this.prisma.xpTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException("task not found");
    return task;
  }

  async updateTask(actorAdminId: string, id: string, dto: Record<string, unknown>) {
    const task = await this.prisma.xpTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException("task not found");
    if (task.status === "archived") throw new BadRequestException("archived tasks are immutable");
    const patch = dto as Partial<{
      name: string;
      description: string | null;
      xpReward: number;
      recurring: string;
      lifetimeLimit: number | null;
      dailyLimit: number | null;
      weeklyLimit: number | null;
      monthlyLimit: number | null;
      cooldownSecs: number | null;
      availableFrom: string | null;
      availableUntil: string | null;
      verificationType: string;
      verificationChecker: string | null;
      scopeAppId: string | null;
      status: string;
    }>;
    if (patch.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(patch.status)) {
      throw new BadRequestException(`status must be one of ${(TASK_STATUSES as readonly string[]).join("|")}`);
    }
    if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 120)) {
      throw new BadRequestException("name must be 1-120 chars");
    }
    if (patch.xpReward !== undefined && (!Number.isInteger(patch.xpReward) || patch.xpReward < 1 || patch.xpReward > MAX_INT)) {
      throw new BadRequestException("xpReward must be an integer 1..100000");
    }
    for (const f of ["lifetimeLimit", "dailyLimit", "weeklyLimit", "monthlyLimit"] as const) {
      const v = patch[f];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1)) {
        throw new BadRequestException(`${f} must be a positive integer or null`);
      }
    }
    if (patch.cooldownSecs !== undefined && patch.cooldownSecs !== null) {
      if (!Number.isInteger(patch.cooldownSecs) || patch.cooldownSecs < 0 || patch.cooldownSecs > 31536000) {
        throw new BadRequestException("cooldownSecs must be an integer 0..31536000 or null");
      }
    }
    if (patch.verificationType !== undefined && !["internal_state", "backend_check"].includes(patch.verificationType)) {
      throw new BadRequestException("verificationType must be internal_state|backend_check");
    }
    validateTaskSemantics({
      recurring: patch.recurring,
      availableFrom: patch.availableFrom ?? task.availableFrom,
      availableUntil: patch.availableUntil ?? task.availableUntil,
    });
    if (patch.scopeAppId !== undefined && patch.scopeAppId !== null) await requireApp(this.prisma, patch.scopeAppId);
    // F8: activation (and staying active under a checker change) requires a
    // registered reliable checker — enforced here, never UI-only.
    const nextStatus = patch.status ?? task.status;
    const nextType = patch.verificationType ?? task.verificationType;
    const nextChecker = patch.verificationChecker !== undefined ? patch.verificationChecker : task.verificationChecker;
    if (nextStatus === "active") {
      const err = validateChecker(nextType, nextChecker);
      if (err) throw new BadRequestException(err);
    }
    const data: Record<string, unknown> = {};
    for (const f of [
      "name",
      "description",
      "xpReward",
      "recurring",
      "lifetimeLimit",
      "dailyLimit",
      "weeklyLimit",
      "monthlyLimit",
      "cooldownSecs",
      "verificationType",
      "verificationChecker",
      "scopeAppId",
      "status",
    ] as const) {
      if (patch[f] !== undefined) data[f] = patch[f];
    }
    if (patch.availableFrom !== undefined) data.availableFrom = patch.availableFrom ? new Date(patch.availableFrom) : null;
    if (patch.availableUntil !== undefined) data.availableUntil = patch.availableUntil ? new Date(patch.availableUntil) : null;
    if (typeof data.name === "string") data.name = data.name.trim();
    const updated = await this.prisma.xpTask.update({ where: { id }, data: data as never });
    await this.security.log(actorAdminId, "admin.xp.task.updated", { taskId: id, patch: Object.keys(data) });
    return updated;
  }
}
