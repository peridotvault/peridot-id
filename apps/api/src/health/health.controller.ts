import { Controller, Get, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

@Controller("v1/health")
@UseGuards(ThrottlerGuard)
export class HealthController {
  @Get()
  @Throttle({ default: { limit: 100, ttl: 60000 } })
  check(): { status: string } {
    return { status: "ok" };
  }
}