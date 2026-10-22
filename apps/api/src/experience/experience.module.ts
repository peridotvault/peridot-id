import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security-event.module";
import { AppCredentialGuard } from "./app-credential.guard";
import { IntakeThrottleAlertFilter } from "./intake-throttle.filter";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";
import { EvidenceService } from "./evidence.service";
import { ExperienceAdminController } from "./experience-admin.controller";
import { ExperienceAdminService } from "./experience-admin.service";
import { LedgerService } from "./ledger.service";
import { LevelsController } from "./levels.controller";
import { LevelsService } from "./levels.service";
import { PolicyBackfillService } from "./policy-backfill.service";
import { QuotaService } from "./quota.service";
import { VerificationService } from "./verification.service";

/**
 * ANT-89 M1 — Leveling Core. Controllers: read-only Level API.
 * Exported for profile read integration (level summary) and the M3 event
 * pipeline (award primitive + permission/quota checks).
 *
 * M2 adds the admin experience API (Role.admin + audit actor everywhere).
 *
 * M3 adds the event intake pipeline (EventsController/EventsService,
 * server-to-server AppCredentialGuard only — never JwtAuthGuard) plus the
 * R4 policy-backfill tooling. Both stay behind the release gate
 * (PID_XP_INTAKE_ENABLED / PID_XP_MIGRATION_ENABLED, exact "true").
 */
@Module({
  imports: [SecurityModule, AuthModule],
  controllers: [LevelsController, ExperienceAdminController, EventsController],
  providers: [
    LevelsService,
    LedgerService,
    QuotaService,
    VerificationService,
    EvidenceService,
    EventsService,
    ExperienceAdminService,
    PolicyBackfillService,
    AppCredentialGuard,
    IntakeThrottleAlertFilter,
  ],
  exports: [LevelsService, LedgerService, QuotaService, VerificationService, EvidenceService, EventsService, ExperienceAdminService, PolicyBackfillService],
})
export class ExperienceModule {}
