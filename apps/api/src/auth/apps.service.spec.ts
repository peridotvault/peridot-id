import { decryptSecret } from "../common/secret-crypto";
import { normalizeOrigin, PidAppsService } from "./apps.service";

// ANT-286a test data key (clearly labeled fixture — never a real secret).
const TEST_ENC_KEY = "ab".repeat(32);

function setup(encKey: string | null = TEST_ENC_KEY) {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    pidApp: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "app-1", isActive: true, ...data };
        rows.set(row.id as string, row);
        return row;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      findFirst: jest.fn(async ({ where }: { where: { id: string; ownerPid: string } }) => {
        const row = rows.get(where.id);
        return row && row.ownerPid === where.ownerPid ? row : null;
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
  const config = { get: (k: string, d?: string) => (k === "PID_SECRETS_ENC_KEY" ? (encKey ?? d ?? "") : (d ?? "")) };
  return { prisma, service: new PidAppsService(prisma as never, config as never) };
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
    expect(app).toMatchObject({ ownerPid: "pid_owner", allowedOrigins: [], isActive: true });
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

  it("stamps a 365d expiry on rotation; expired secrets fail closed", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    const before = Date.now();
    const { secret } = await service.rotateSecret("pid_owner", app.id as string);
    const stored = (await prisma.pidApp.findUnique({ where: { clientId: app.clientId as string } })) as Record<
      string,
      unknown
    >;
    const expiresAt = stored.clientSecretExpiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(before + 364 * 24 * 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 366 * 24 * 60 * 60 * 1000);

    // Fresh secret valid; wrong secret and expired deadline rejected.
    expect(service.clientSecretValid(stored as never, secret)).toBe(true);
    expect(service.clientSecretValid(stored as never, "wrong")).toBe(false);
    expect(
      service.clientSecretValid(
        { clientSecretHash: stored.clientSecretHash as string, clientSecretExpiresAt: new Date(Date.now() - 1000) },
        secret,
      ),
    ).toBe(false);
    // Public clients (no secret set) stay valid without a secret.
    expect(service.clientSecretValid({ clientSecretHash: null }, "")).toBe(true);
  });

  it("peppers hashes when PID_APP_SECRET_PEPPER is set, keeps legacy rows verifying", async () => {
    const { prisma } = setup();
    const pepperedConfig = { get: (k: string, d?: string) => (k === "PID_APP_SECRET_PEPPER" ? "pepper-1" : (d ?? "")) };
    const peppered = new PidAppsService(prisma as never, pepperedConfig as never);
    const app = await peppered.create("pid_owner", "My Game");
    const { secret } = await peppered.rotateSecret("pid_owner", (app as Record<string, unknown>).id as string);
    const stored = (await prisma.pidApp.findUnique({
      where: { clientId: (app as Record<string, unknown>).clientId as string },
    })) as Record<string, unknown>;
    // Peppered hash differs from the legacy unsalted hash …
    expect(stored.clientSecretHash).toBe(PidAppsService.hashSecret(secret, "pepper-1"));
    expect(stored.clientSecretHash).not.toBe(PidAppsService.hashSecret(secret));
    // … verifies with the pepper …
    expect(peppered.clientSecretValid(stored as never, secret)).toBe(true);
    expect(peppered.clientSecretValid(stored as never, "wrong")).toBe(false);
    // … and pre-pepper legacy rows (no pepper in hash) keep verifying until rotated.
    const legacy = { clientSecretHash: PidAppsService.hashSecret(secret), clientSecretExpiresAt: null };
    expect(peppered.clientSecretValid(legacy, secret)).toBe(true);
  });

  it("only lets owners rotate their app secret", async () => {
    const { service } = setup();
    const app = await service.create("pid_owner", "My Game");
    await expect(service.rotateSecret("pid_stranger", app.id as string)).rejects.toThrow("App not found");
  });

  it("stores the webhook secret envelope-encrypted (ANT-286a)", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    const { url, secret } = await service.setWebhook("pid_owner", app.id as string, "https://mygame.dev/hook");
    expect(secret).toMatch(/^pidwh_[0-9a-f]{48}$/);
    expect(url).toBe("https://mygame.dev/hook");
    const stored = (await prisma.pidApp.findUnique({ where: { clientId: (app as Record<string, unknown>).clientId as string } })) as Record<string, unknown>;
    const storedSecret = stored.webhookSecret as string;
    expect(storedSecret.startsWith("enc:v1:")).toBe(true);
    expect(storedSecret).not.toContain(secret as string);
    expect(decryptSecret(storedSecret, TEST_ENC_KEY)).toBe(secret);
  });

  it("fails closed on setWebhook without a usable data key (never stores plaintext)", async () => {
    const { prisma, service } = setup(null);
    const app = await service.create("pid_owner", "My Game");
    await expect(service.setWebhook("pid_owner", app.id as string, "https://mygame.dev/hook")).rejects.toThrow(
      "PID_SECRETS_ENC_KEY",
    );
    const stored = (await prisma.pidApp.findUnique({ where: { clientId: (app as Record<string, unknown>).clientId as string } })) as Record<string, unknown>;
    expect(stored?.webhookSecret ?? null).toBeNull();
  });

  it("keeps the previous secret valid for the 24h grace window, then fails closed", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    const first = await service.rotateSecret("pid_owner", app.id as string);
    // First issuance: no previous secret, so no grace deadline.
    expect(first.graceExpiresAt).toBeNull();
    const afterFirst = (await prisma.pidApp.findUnique({
      where: { clientId: app.clientId as string },
    })) as Record<string, unknown>;
    expect(afterFirst.prevClientSecretHash).toBeNull();

    const second = await service.rotateSecret("pid_owner", app.id as string);
    expect(second.graceExpiresAt).toBeInstanceOf(Date);
    const stored = (await prisma.pidApp.findUnique({
      where: { clientId: app.clientId as string },
    })) as unknown as Parameters<typeof service.clientSecretValid>[0];
    // New secret valid; previous secret still valid inside the grace window.
    expect(service.clientSecretValid(stored, second.secret)).toBe(true);
    expect(service.clientSecretValid(stored, first.secret)).toBe(true);
    expect(service.clientSecretValid(stored, "wrong")).toBe(false);

    // Expired grace: previous secret stops verifying, current keeps working.
    const expired = {
      ...stored,
      prevClientSecretExpiresAt: new Date(Date.now() - 1000),
    };
    expect(service.clientSecretValid(expired, first.secret)).toBe(false);
    expect(service.clientSecretValid(expired, second.secret)).toBe(true);
  });

  it("supersedes the previous grace window on a second rotation", async () => {
    const { prisma, service } = setup();
    const app = await service.create("pid_owner", "My Game");
    const first = await service.rotateSecret("pid_owner", app.id as string);
    const second = await service.rotateSecret("pid_owner", app.id as string);
    const third = await service.rotateSecret("pid_owner", app.id as string);
    const stored = (await prisma.pidApp.findUnique({
      where: { clientId: app.clientId as string },
    })) as unknown as Parameters<typeof service.clientSecretValid>[0];
    // Only the current + immediately-previous secrets verify; the oldest is dropped.
    expect(service.clientSecretValid(stored, third.secret)).toBe(true);
    expect(service.clientSecretValid(stored, second.secret)).toBe(true);
    expect(service.clientSecretValid(stored, first.secret)).toBe(false);
  });
});
