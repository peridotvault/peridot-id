import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { ExperienceAdminController } from "./experience-admin.controller";
import { ExperienceAdminService } from "./experience-admin.service";
import { LedgerService } from "./ledger.service";
import { LevelsController } from "./levels.controller";
import { LevelsService } from "./levels.service";
import { QuotaService } from "./quota.service";
import { VerificationService } from "./verification.service";

/**
 * ANT-89 M1 — Leveling Core. Controllers: read-only Level API.
 * Exported for profile read integration (level summary) and the M3 event
 * pipeline (award primitive + permission/quota checks).
 *
 * M2 adds the admin experience API (Role.admin + audit actor everywhere).
 */
@Module({
  imports: [SecurityModule],
  controllers: [LevelsController, ExperienceAdminController],
  providers: [LevelsService, LedgerService, QuotaService, VerificationService, ExperienceAdminService],
  exports: [LevelsService, LedgerService, QuotaService, VerificationService, ExperienceAdminService],
})
export class ExperienceModule {}
