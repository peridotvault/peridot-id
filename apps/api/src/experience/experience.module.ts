import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security-event.module";
import { BackfillRunService } from "../settings/backfill-run.service";
import { BackfillRunController } from "../settings/settings-admin.controller";
import { SettingsModule } from "../settings/settings.module";
import { AppCredentialGuard } from "./app-credential.guard";
import { IntakeThrottleAlertFilter } from "./intake-throttle.filter";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";
import { EvidenceService } from "./evidence.service";
import { ExperienceAdminController } from "./experience-admin.controller";
import { ExperienceAdminService } from "./experience-admin.service";
import { ExperiencePoliciesService } from "./experience-policies.service";
import { ExperienceTasksService } from "./experience-tasks.service";
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
 * R4 policy-backfill tooling. Intake awarding is gated only by the
 * xp.suspend.* kill-switches; migration execution stays behind
 * PID_XP_MIGRATION_ENABLED (exact "true").
 */
@Module({
  imports: [SecurityModule, AuthModule, SettingsModule],
  controllers: [LevelsController, ExperienceAdminController, EventsController, BackfillRunController],
  providers: [
    LevelsService,
    LedgerService,
    QuotaService,
    VerificationService,
    EvidenceService,
    EventsService,
    ExperienceAdminService,
    ExperiencePoliciesService,
    ExperienceTasksService,
    PolicyBackfillService,
    BackfillRunService,
    AppCredentialGuard,
    IntakeThrottleAlertFilter,
  ],
  exports: [LevelsService, LedgerService, QuotaService, VerificationService, EvidenceService, EventsService, ExperienceAdminService, PolicyBackfillService, BackfillRunService],
})
export class ExperienceModule {}
