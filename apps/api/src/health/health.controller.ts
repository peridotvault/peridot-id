import { Controller, Get, HttpException, HttpStatus, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { PrismaService } from "../prisma/prisma.service";

export interface HealthStatus {
  status: "ok" | "degraded";
  db: "up" | "down";
  sha: string;
}

// ANT-385: liveness + DB dependency check. 200 {"status":"ok","db":"up"}
// when Postgres answers SELECT 1; 503 {"status":"degraded","db":"down"}
// otherwise so the compose healthcheck (r.ok) marks the container
// unhealthy instead of serving traffic against a dead DB. `sha` is the
// GIT_SHA build arg (up.sh) — image traceability without a second lookup.
@Controller("v1/health")
@UseGuards(ThrottlerGuard)
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Throttle({ default: { limit: 100, ttl: 60000 } })
  async check(): Promise<HealthStatus> {
    const sha = process.env.GIT_SHA ?? "unknown";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", db: "up", sha };
    } catch {
      throw new HttpException(
        { status: "degraded", db: "down", sha } as HealthStatus,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
