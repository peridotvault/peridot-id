import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { LevelsController } from "./levels.controller";
import { LevelsService } from "./levels.service";
import { QuotaService } from "./quota.service";
import { VerificationService } from "./verification.service";

/**
 * ANT-89 M1 — Leveling Core. Controllers: read-only Level API.
 * Exported for profile read integration (level summary) and the M3 event
 * pipeline (award primitive + permission/quota checks).
 */
@Module({
  controllers: [LevelsController],
  providers: [LevelsService, LedgerService, QuotaService, VerificationService],
  exports: [LevelsService, LedgerService, QuotaService, VerificationService],
})
export class ExperienceModule {}
