import { originsOf, PidAppsService } from "./apps.service";

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    pidApp: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "app-1", isActive: true, ...data };
        rows.set(row.id as string, row);
        return row;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      findFirst: jest.fn(async ({ where }: { where: { id: string; ownerId: string } }) => {
        const row = rows.get(where.id);
        return row && row.ownerId === where.ownerId ? row : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        [...rows.values()].find((r) => r.clientId === where.clientId) ?? null,
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return row;
      }),
    },
  };
  return { prisma, service: new PidAppsService(prisma as never) };
}

describe("PidAppsService", () => {
  it("derives allowed origins from redirect URIs", () => {
    expect(originsOf(["https://mygame.dev/callback", "https://mygame.dev/other", "http://localhost:3000/x"])).toEqual([
      "https://mygame.dev",
      "http://localhost:3000",
    ]);
  });

  it("creates an app with a public client_id owned by the caller", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game", ["https://mygame.dev/callback"]);
    expect(app.clientId).toMatch(/^pidapp_[0-9a-f]{32}$/);
    expect(app).toMatchObject({
      ownerId: "pid_owner",
      allowedOrigins: ["https://mygame.dev"],
      isActive: true,
    });
  });

  it("only lets owners update their own apps (and re-derives origins)", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game", ["https://mygame.dev/callback"]);
    await expect(service.update("pid_stranger", app.id as string, { name: "Hijacked" })).rejects.toThrow("App not found");
    const updated = await service.update("pid_owner", app.id as string, {
      redirectUris: ["https://mygame.dev/v2/callback"],
      isActive: false,
    });
    expect(updated).toMatchObject({ allowedOrigins: ["https://mygame.dev"], isActive: false });
  });

  it("findActive hides unknown and disabled apps", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game", ["https://mygame.dev/callback"]);
    expect(await service.findActive(app.clientId as string)).toBeTruthy();
    expect(await service.findActive("pidapp_missing")).toBeNull();
    await prisma.pidApp.update({ where: { id: app.id as string }, data: { isActive: false } });
    expect(await service.findActive(app.clientId as string)).toBeNull();
  });
});
