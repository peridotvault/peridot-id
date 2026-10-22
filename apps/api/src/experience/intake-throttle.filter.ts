import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { PrismaService } from "../prisma/prisma.service";

/**
 * ANT-89 M3 (ANT-441) — 429/quota-breach alerting hook, intake side (Tobias F7).
 *
 * Catches throttler rejections on POST /v1/experience/events and records a
 * fire-and-forget `xp.intake.throttled` suspicious-activity row (client_id +
 * user_id from the body when present) before rethrowing the ORIGINAL 429
 * untouched — the wire envelope never changes. The monitoring slice (Trevor,
 * ANT-445) consumes this feed for 429-spike alerting; quota-breach rows are
 * written by the award pipeline itself (`xp.intake.quota_exceeded`).
 *
 * Best-effort by design: feed writes never fail the rejection, never read
 * cookies/sessions, and never persist secret material.
 */
@Catch(ThrottlerException)
export class IntakeThrottleAlertFilter implements ExceptionFilter {
  private readonly logger = new Logger(IntakeThrottleAlertFilter.name);

  constructor(private readonly prisma: PrismaService) {}

  async catch(exception: ThrottlerException, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<{ body?: Record<string, unknown> }>();
    const res = ctx.getResponse() as unknown as { status: (code: number) => { json: (body: unknown) => unknown } };
    const body = req.body ?? {};
    const clientId = typeof body.client_id === "string" ? body.client_id.slice(0, 128) : null;
    const userId = typeof body.user_id === "string" ? body.user_id.slice(0, 64) : null;
    try {
      await this.prisma.xpSuspiciousActivity.create({
        data: {
          pid: null,
          appId: null,
          signal: "xp.intake.throttled",
          detail: { clientId, userId },
        },
      });
    } catch (e) {
      this.logger.warn(`throttle-feed write failed (429 still returned): ${(e as Error).message}`);
    }
    res.status(429).json({ statusCode: 429, message: "ThrottlerException: Too Many Requests" });
  }
}
