import { Module } from "@nestjs/common";
import { ClaimService } from "../auth/claim.service";
import { SecurityModule } from "../security/security-event.module";
import { PidsController } from "./pids.controller";
import { PidsService } from "./pids.service";

@Module({
  imports: [SecurityModule],
  controllers: [PidsController],
  providers: [ClaimService, PidsService],
  exports: [PidsService],
})
export class PidsModule {}
