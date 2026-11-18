import { Module } from "@nestjs/common";
import { UsageService } from "./usage.service";

/** Web3 usage metering (stage 5 of docs/plan/05). Reporting-only. */
@Module({
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
