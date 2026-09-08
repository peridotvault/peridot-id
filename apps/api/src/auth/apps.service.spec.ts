import { normalizeOrigin, PidAppsService } from "./apps.service";

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
  it("normalizeOrigin accepts bare origins, normalizes slashes and case", () => {
    expect(normalizeOrigin("https://mygame.dev")).toBe("https://mygame.dev");
    expect(normalizeOrigin("https://mygame.dev///")).toBe("https://mygame.dev");
    expect(normalizeOrigin("https://MyGame.DEV")).toBe("https://mygame.dev");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("https://mygame.dev:8443")).toBe("https://mygame.dev:8443");
  });

  it("normalizeOrigin rejects paths, queries, fragments, and non-http schemes", () => {
    for (const bad of [
      "https://mygame.dev/callback",
      "https://mygame.dev?x=1",
      "https://mygame.dev#frag",
      "ftp://mygame.dev",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(() => normalizeOrigin(bad)).toThrow();
    }
  });

  it("creates an app with name only; origins managed after", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game");
    expect(app.clientId).toMatch(/^pidapp_[0-9a-f]{32}$/);
    expect(app).toMatchObject({ ownerId: "pid_owner", allowedOrigins: [], isActive: true });
  });

  it("creates with initial origins, deduped and normalized", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game", [
      "https://mygame.dev",
      "https://mygame.dev/",
      "http://localhost:3000",
    ]);
    expect(app).toMatchObject({ allowedOrigins: ["https://mygame.dev", "http://localhost:3000"] });
  });

  it("only lets owners update their own apps (origins replaced wholesale)", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game");
    await expect(service.update("pid_stranger", app.id as string, { name: "Hijacked" })).rejects.toThrow("App not found");
    const updated = await service.update("pid_owner", app.id as string, {
      allowedOrigins: ["https://mygame.dev", "https://staging.mygame.dev"],
      isActive: false,
    });
    expect(updated).toMatchObject({
      allowedOrigins: ["https://mygame.dev", "https://staging.mygame.dev"],
      isActive: false,
    });
  });

  it("findActive hides unknown and disabled apps", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    expect(await service.findActive(app.clientId as string)).toBeTruthy();
    expect(await service.findActive("pidapp_missing")).toBeNull();
    await prisma.pidApp.update({ where: { id: app.id as string }, data: { isActive: false } });
    expect(await service.findActive(app.clientId as string)).toBeNull();
  });

  it("rotates a backend secret, storing only the hash", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    const { secret, prefix } = await service.rotateSecret("pid_owner", app.id as string);
    expect(secret).toMatch(/^pidsk_[0-9a-f]{48}$/);
    expect(prefix).toBe(secret.slice(0, 12));

    const stored = await prisma.pidApp.findUnique({ where: { clientId: app.clientId as string } });
    expect(stored?.clientSecretHash).toBe(PidAppsService.hashSecret(secret));
    expect(stored?.clientSecretHash).not.toContain(secret);
    expect(PidAppsService.secretMatches(secret, stored?.clientSecretHash as string)).toBe(true);
    expect(PidAppsService.secretMatches("wrong", stored?.clientSecretHash as string)).toBe(false);
  });

  it("only lets owners rotate their app secret", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game");
    await expect(service.rotateSecret("pid_stranger", app.id as string)).rejects.toThrow("App not found");
  });
});
