// ANT-804 D3 admin verification contract (§6.3) focused tests.
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AdminService } from "./admin.service";

function setup() {
  const apps = new Map<string, any>();
  apps.set("pidapp_demo", {
    id: "id-1", clientId: "pidapp_demo", ownerPid: "o@pid", name: "Demo",
    isActive: true, isVerified: false, verificationExpiresAt: null,
    updatedAt: new Date("2026-10-28T00:00:00.000Z"),
  });
  const audits: any[] = [];
  const prisma: any = {
    pidApp: {
      findUnique: jest.fn(async ({ where }: any) =>
        [...apps.values()].find((a) => (where.clientId ? a.clientId === where.clientId : a.id === where.id)) ?? null),
      findMany: jest.fn(async ({ where }: any = {}) => {
        let rows = [...apps.values()];
        if (where?.isVerified === true) rows = rows.filter((a) => a.isVerified);
        if (where?.isVerified === false && !where?.verificationExpiresAt) rows = rows.filter((a) => !a.isVerified);
        return rows.map((a) => ({ ...a }));
      }),
      update: jest.fn(async ({ where, data, select }: any) => {
        const cur = [...apps.values()].find((a) => (where.clientId ? a.clientId === where.clientId : a.id === where.id));
        const next = { ...cur, ...data, updatedAt: new Date("2026-10-28T01:00:00.000Z") };
        apps.set(next.clientId, next);
        void select;
        return next;
      }),
    },
    pidVerificationAudit: { create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  const security: any = { log: jest.fn(async () => undefined) };
  const svc = new AdminService(prisma, {} as never, {} as never, {} as never, security);
  return { svc, prisma, security, audits, apps };
}

describe("AdminService verification contract (§6.3)", () => {
  it("grant → 200 shape {clientId,isVerified,updatedBy,updatedAt} + fee-relevant flag + audit (AC-D3.2)", async () => {
    const { svc, audits, security } = setup();
    const out = await svc.grantVerification("admin@pid", "pidapp_demo", {
      isVerified: true, justification: "official partner integration", expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(out).toEqual({
      clientId: "pidapp_demo", isVerified: true, updatedBy: "admin@pid", updatedAt: expect.any(String),
    });
    expect(audits.some((a) => a.action === "granted" && a.actorPid === "admin@pid")).toBe(true);
    expect(security.log).toHaveBeenCalledWith("admin@pid", "admin.app.verified", expect.objectContaining({ clientId: "pidapp_demo" }));
  });

  it("revoke → isVerified=false + recorded notice (AC-D3.4)", async () => {
    const { svc, audits, apps } = setup();
    apps.get("pidapp_demo").isVerified = true;
    const out = await svc.grantVerification("admin@pid", "pidapp_demo", { isVerified: false, justification: "ToS violation confirmed" });
    expect(out.isVerified).toBe(false);
    expect(audits.some((a) => a.action === "revoked")).toBe(true);
  });

  it("rejects short justification and past expiry (negative)", async () => {
    const { svc } = setup();
    await expect(svc.grantVerification("admin@pid", "pidapp_demo", { isVerified: true, justification: "ok" }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.grantVerification("admin@pid", "pidapp_demo", {
      isVerified: true, justification: "long enough justification", expiresAt: new Date(Date.now() - 1000).toISOString(),
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404 for unknown clientId", async () => {
    const { svc } = setup();
    await expect(svc.grantVerification("admin@pid", "pidapp_nope", { isVerified: true, justification: "long enough justification" }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
