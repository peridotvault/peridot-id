import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security-event.module";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { RelayerIdempotencyService } from "./relayer-idempotency.service";
import { RevocationMonitor } from "./revocation-monitor.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  providers: [RelayerIdempotencyService, CircuitBreakerService, RevocationMonitor],
  exports: [RelayerIdempotencyService, CircuitBreakerService, RevocationMonitor],
})
export class RelayerModule {}
