// ANT-456 — settings module: SystemSetting reads/writes + XP domain
// accessors + admin settings routes. Imported by ExperienceModule (which
// additionally hosts the backfill-run controller/service next to the
// PolicyBackfillService it orchestrates) and by AppModule (admin routes).

import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security-event.module";
import { SettingsAdminController } from "./settings-admin.controller";
import { SettingsService } from "./settings.service";
import { XpSettingsService } from "./xp-settings.service";

@Module({
  imports: [SecurityModule],
  controllers: [SettingsAdminController],
  providers: [SettingsService, XpSettingsService],
  exports: [SettingsService, XpSettingsService],
})
export class SettingsModule {}
