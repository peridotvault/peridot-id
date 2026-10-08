import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import { EmailOtpService } from "./email-otp.service";

const PEPPER = "test-pepper";
const hashOf = (code: string) => createHash("sha256").update(`${PEPPER}:${code}`).digest("hex");

function setup(opts: { configured?: boolean; rows?: Record<string, any>[] } = {}) {
  const rows: Record<string, any>[] = opts.rows ?? [];
  const prisma: Record<string, any> = {
    emailOtp: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async (args: { where: { email: string } }) =>
        rows.find((r) => r.email === args.where.email && !r.consumedAt && r.expiresAt > new Date()) ?? null,
      ),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `otp_${rows.length}`, attempts: 0, consumedAt: null, ...args.data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error("row not found");
        Object.assign(row, args.data);
        return row;
      }),
    },
  };
  const email = { sendOtp: jest.fn(async () => undefined), isConfigured: () => opts.configured ?? true };
  const config = { get: (k: string, d?: string) => (k === "EMAIL_OTP_PEPPER" ? PEPPER : (d ?? "")) };
  const service = new EmailOtpService(prisma as never, email as never, config as never);
  return { service, prisma, email, rows };
}

function liveRow(code: string, overrides: Record<string, any> = {}) {
  return {
    id: "otp_1",
    email: "user@example.com",
    codeHash: hashOf(code),
    expiresAt: new Date(Date.now() + 600_000),
    attempts: 0,
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("EmailOtpService", () => {
  it("requests a code without storing it in plaintext", async () => {
    const { service, prisma, email, rows } = setup();
    await expect(service.request("User@Example.com".toLowerCase(), "1.2.3.4")).resolves.toEqual({ ok: true });
    expect(prisma.emailOtp.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "user@example.com", requestIp: "1.2.3.4" }),
    });
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].codeHash).not.toContain("123");
    expect(email.sendOtp).toHaveBeenCalledWith("user@example.com", expect.stringMatching(/^\d{6}$/));
  });

  it("rejects a resend within the cooldown and caps hourly requests", async () => {
    const now = Date.now();
    const { service } = setup({ rows: [liveRow("123456", { createdAt: new Date(now - 10_000) })] });
    await expect(service.request("user@example.com", undefined)).rejects.toThrow(ThrottlerException);

    const many = Array.from({ length: 5 }, (_, i) => liveRow("000000", { id: `otp_${i}`, createdAt: new Date(now - 30 * 60_000) }));
    const capped = setup({ rows: many });
    await expect(capped.service.request("user@example.com", undefined)).rejects.toThrow(ThrottlerException);
  });

  it("verifies the code once and consumes it", async () => {
    const { service, prisma } = setup({ rows: [liveRow("428311")] });
    await expect(service.verify("user@example.com", "428311")).resolves.toBe("user@example.com");
    expect(prisma.emailOtp.update).toHaveBeenCalledWith({ where: { id: "otp_1" }, data: { consumedAt: expect.any(Date) } });
  });

  it("fails closed with the same message for wrong, missing, and expired codes", async () => {
    const { service } = setup({ rows: [liveRow("428311")] });
    await expect(service.verify("user@example.com", "000000")).rejects.toThrow("invalid or expired");
    await expect(service.verify("nobody@example.com", "428311")).rejects.toThrow("invalid or expired");

    const expired = setup({ rows: [liveRow("428311", { expiresAt: new Date(Date.now() - 1000) })] });
    // findFirst filters expired rows, so the mock returns null → same message.
    await expect(expired.service.verify("user@example.com", "428311")).rejects.toThrow("invalid or expired");
  });

  it("locks the row after 5 wrong attempts", async () => {
    const { service, rows } = setup({ rows: [liveRow("428311")] });
    for (let i = 0; i < 5; i++) {
      await expect(service.verify("user@example.com", "000000")).rejects.toThrow(BadRequestException);
    }
    expect(rows[0].attempts).toBe(5);
    expect(rows[0].consumedAt).not.toBeNull();
    // Even the right code fails after lockout — same message.
    await expect(service.verify("user@example.com", "428311")).rejects.toThrow("invalid or expired");
  });

  it("refuses to verify when the sender is unconfigured", async () => {
    const { service } = setup({ configured: false, rows: [liveRow("428311")] });
    await expect(service.verify("user@example.com", "428311")).rejects.toThrow(ServiceUnavailableException);
  });
});
