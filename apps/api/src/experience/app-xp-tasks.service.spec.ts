import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ExperienceTasksService } from "./experience-tasks.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakePrisma(app: any) {
  const tasks: any[] = [];
  const apps: any[] = [{ ...app }];
  return {
    tasks,
    apps,
    pidApp: {
      findFirst: async ({ where }: any) =>
        apps.find((a) => a.id === where.id && (where.ownerPid === undefined || a.ownerPid === where.ownerPid)) ?? null,
      update: async ({ where, data }: any) => {
        const row = apps.find((a) => a.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    xpTask: {
      count: async ({ where }: any) => tasks.filter((t) => t.scopeAppId === where.scopeAppId).length,
      findFirst: async ({ where }: any) =>
        tasks.find((t) => t.key === where.key && t.scopeAppId === where.scopeAppId) ?? null,
      findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `task-${tasks.length + 1}`, status: "draft", ...data };
        tasks.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = tasks.find((t) => t.id === where.id);
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ where }: any) => tasks.filter((t) => t.scopeAppId === where.scopeAppId),
    },
  };
}

const security = { log: async () => undefined } as any;
const VERIFIED = {
  id: "app-1",
  ownerPid: "owner@pid",
  isActive: true,
  isVerified: true,
  xpEnabled: false,
  approvedEventTypes: [] as string[],
};

describe("ExperienceTasksService self-serve app tasks", () => {
  it("rejects unverified apps (verified gate)", async () => {
    const prisma = fakePrisma({ ...VERIFIED, isVerified: false });
    const svc = new ExperienceTasksService(prisma as never, security);
    await expect(
      svc.createAppTask("owner@pid", "app-1", { key: "campaign_completed", name: "Done", xpReward: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("forces scope/checker/status/unlimited and auto-approves the event type", async () => {
    const prisma = fakePrisma(VERIFIED);
    const svc = new ExperienceTasksService(prisma as never, security);
    const task = await svc.createAppTask("owner@pid", "app-1", {
      key: "campaign_completed",
      name: "Campaign completed",
      xpReward: 100,
    });
    expect(task).toMatchObject({
      key: "campaign_completed",
      scopeAppId: "app-1",
      verificationChecker: "backend_check.app_attested",
      verificationType: "backend_check",
      recurring: "unlimited",
      status: "active",
      xpReward: 100,
    });
    expect(task.dailyLimit ?? null).toBeNull();
    expect(task.cooldownSecs ?? null).toBeNull();
    expect(prisma.apps[0]).toMatchObject({ xpEnabled: true, approvedEventTypes: ["campaign_completed"] });
  });

  it("caps XP per event at 1000 and rejects duplicate keys per app", async () => {
    const prisma = fakePrisma(VERIFIED);
    const svc = new ExperienceTasksService(prisma as never, security);
    await expect(
      svc.createAppTask("owner@pid", "app-1", { key: "too_big", name: "Too big", xpReward: 1001 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.createAppTask("owner@pid", "app-1", { key: "campaign_completed", name: "Done", xpReward: 100 });
    await expect(
      svc.createAppTask("owner@pid", "app-1", { key: "campaign_completed", name: "Again", xpReward: 100 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("never touches another owner's app", async () => {
    const prisma = fakePrisma(VERIFIED);
    const svc = new ExperienceTasksService(prisma as never, security);
    await expect(svc.listAppTasks("stranger@pid", "app-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("update is limited to own tasks and own fields", async () => {
    const prisma = fakePrisma(VERIFIED);
    const svc = new ExperienceTasksService(prisma as never, security);
    const task = await svc.createAppTask("owner@pid", "app-1", { key: "campaign_completed", name: "Done", xpReward: 100 });
    const updated = await svc.updateAppTask("owner@pid", "app-1", task.id, { xpReward: 250, status: "disabled" });
    expect(updated).toMatchObject({ xpReward: 250, status: "disabled", scopeAppId: "app-1" });
    await expect(svc.updateAppTask("stranger@pid", "app-1", task.id, { xpReward: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.updateAppTask("owner@pid", "app-1", task.id, { status: "archived" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
