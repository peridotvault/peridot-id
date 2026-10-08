import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { EmailService } from "./email.service";

// ponytail: fixed auth-only policy, env only for secrets — add knobs when abuse data says so.
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

function hashCode(code: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${code}`).digest("hex");
}

function codesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Email-OTP login challenges. The 6-digit code is never stored — only its
 * SHA-256 hash — and each row is single-use (consumedAt). Request and verify
 * both fail closed with generic messages (no account-enumeration signal).
 */
@Injectable()
export class EmailOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private pepper(): string {
    return (
      this.config.get<string>("EMAIL_OTP_PEPPER", "") ||
      this.config.get<string>("JWT_REFRESH_SECRET", "email-otp-dev-pepper")
    );
  }

  /**
   * Issue a fresh code and send it. Always resolves { ok: true } — even for
   * unknown emails and even when the sender is unconfigured (dev fallback) —
   * so the response never reveals whether an address has an account.
   * Rate limits (cooldown + hourly cap) 429 regardless of account existence.
   */
  async request(email: string, requestIp: string | undefined): Promise<{ ok: true }> {
    const now = new Date();
    const recent = await this.prisma.emailOtp.findMany({
      where: { email, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, consumedAt: true, expiresAt: true },
    });
    if (recent.length >= OTP_MAX_PER_HOUR) throw new ThrottlerException("Too many codes requested — try again later.");
    const live = recent.find((r) => !r.consumedAt && r.expiresAt > now);
    if (live && now.getTime() - live.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new ThrottlerException("A code was just sent — wait a minute before requesting another.");
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.prisma.emailOtp.create({
      data: {
        email,
        codeHash: hashCode(code, this.pepper()),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        requestIp: requestIp ?? null,
      },
    });
    try {
      await this.email.sendOtp(email, code);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException("Couldn't send the code — please try again.");
    }
    return { ok: true as const };
  }

  /**
   * Consume the latest live code for the email. Returns the verified email.
   * Wrong codes increment attempts (5 strikes invalidates the row); every
   * failure is the same generic message so guesses learn nothing.
   */
  async verify(email: string, code: string): Promise<string> {
    if (!this.email.isConfigured()) {
      throw new ServiceUnavailableException("Email sign-in is not available right now — please try again later.");
    }
    const now = new Date();
    const row = await this.prisma.emailOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new BadRequestException("That code is invalid or expired — request a new one.");
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
      throw new BadRequestException("That code is invalid or expired — request a new one.");
    }
    if (!codesEqual(hashCode(code, this.pepper()), row.codeHash)) {
      const attempts = row.attempts + 1;
      await this.prisma.emailOtp.update({
        where: { id: row.id },
        data: attempts >= OTP_MAX_ATTEMPTS ? { attempts, consumedAt: now } : { attempts },
      });
      throw new BadRequestException("That code is invalid or expired — request a new one.");
    }
    await this.prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
    return email;
  }
}
