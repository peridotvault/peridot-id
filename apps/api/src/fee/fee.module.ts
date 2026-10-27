import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { FeePolicyController } from "./fee-policy.controller";
import { FeePolicyService } from "./fee-policy.service";

@Module({
  imports: [SecurityModule],
  controllers: [FeePolicyController],
  providers: [FeePolicyService],
  exports: [FeePolicyService],
})
export class FeeModule {}
