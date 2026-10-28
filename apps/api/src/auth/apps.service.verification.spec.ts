// ANT-804 D3 focused tests: deny-by-default, negative privilege-escalation,
// origins re-review, expiry helper (no DB — mocked delegates).
import { PidAppsService } from "./apps.service";

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const audits: Record<string, unknown>[] = [];
  const prisma: any = {
    pidApp: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: "app-1", clientId: (data as any).clientId, isActive: true, allowedOrigins: [], ...data };
        rows.set(row.id as string, row);
        return row;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        return row && row.ownerPid === where.ownerPid ? row : null;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        [...rows.values()].find((r) => (where.clientId ? r.clientId === where.clientId : r.id === where.id)) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const key = where.id ?? [...rows.values()].find((r) => r.clientId === where.clientId)?.id;
        const row = { ...rows.get(key), ...data };
        rows.set(key, row);
        return row;
      }),
    },
    pidVerificationAudit: {
      create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }),
    },
  };
  const config: any = { get: (k: string, d?: string) => d ?? "" };
  const logs: any[] = [];
  const security: any = { log: jest.fn(async (...a: any[]) => { logs.push(a); }) };
  return { prisma, service: new PidAppsService(prisma, config, security), audits, logs, rows };
}

describe("PidAppsService D3 deny-by-default (AC-D3.1/D3.3/D3.5)", () => {
  it("self-serve create is always isVerified=false (no auto-verified)", async () => {
    const { service } = setup();
    const app = await service.create("owner@pid", "Game", ["https://game.dev"]);
    expect(app.isVerified).toBe(false);
  });

  it("self-serve update strips a smuggled isVerified=true (negative, AC-D3.3)", async () => {
    const { service, prisma } = setup();
    await service.create("owner@pid", "Game");
    const out = await service.update("owner@pid", "app-1", { name: "Game 2", isVerified: true } as any);
    expect((out as any).isVerified).toBe(false);
    expect(prisma.pidApp.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ isVerified: expect.anything() }) }),
    );
  });

  it("origins change on a verified app forces re-review: waiver off + audit (edge 7)", async () => {
    const { service, audits, logs } = setup();
    await service.create("owner@pid", "Game", ["https://game.dev"]);
    // Simulate an admin grant behind the service (deny-by-default start).
    await service["prisma"].pidApp.update({ where: { id: "app-1" }, data: { isVerified: true } });
    const out = await service.update("owner@pid", "app-1", { allowedOrigins: ["https://evil.dev"] });
    expect((out as any).isVerified).toBe(false);
    expect(audits.some((a) => a.action === "re_review")).toBe(true);
    expect(logs.some(([ , type]: any[]) => type === "app.verification.revoked")).toBe(true);
  });

  it("isVerificationActive: false when expired, true otherwise", () => {
    expect(PidAppsService.isVerificationActive({ isVerified: false })).toBe(false);
    expect(PidAppsService.isVerificationActive({ isVerified: true })).toBe(true);
    expect(PidAppsService.isVerificationActive({ isVerified: true, verificationExpiresAt: new Date(Date.now() + 3600_000) })).toBe(true);
    expect(PidAppsService.isVerificationActive({ isVerified: true, verificationExpiresAt: new Date(Date.now() - 1000) })).toBe(false);
  });
});
