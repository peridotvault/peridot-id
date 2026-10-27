import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { skipIfAnon, skipIfAuthed, USER_THROTTLER, userThrottleTracker } from "./common/user-throttle";
import { AccountModule } from "./account/account.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BatchQueueModule } from "./batch-queue/batch-queue.module";
import { CredentialModule } from "./credentials/credential.module";
import { EnvModule } from "./env/env.module";
import { ExperienceModule } from "./experience/experience.module";
import { FeeModule } from "./fee/fee.module";
import { XP_INTAKE_APP_PID_THROTTLER, XP_INTAKE_APP_THROTTLER, xpIntakeAppPidTracker, xpIntakeAppTracker } from "./experience/rate-limit";
import { FiatModule } from "./fiat/fiat.module";
import { IdentityModule } from "./identity/identity.module";
import { IntentModule } from "./intent/intent.module";
import { OpenApiModule } from "./openapi/openapi.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { ProfileModule } from "./profile/profile.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SecurityModule } from "./security/security-event.module";
import { SessionKeysModule } from "./session-keys/session-keys.module";
import { WalletModule } from "./wallet/wallet.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // ANT-441 M3 (Tobias F5): intake inner tiers below the global default —
    // per-app (60/min) and per-app+subject (30/min), keyed by rate-limit.ts
    // trackers (client_id from the body, IP fallback when absent).
    // Per-user vs anonymous buckets: a verified session/app token skips the
    // per-IP bucket and counts against its own PID bucket (500/min) instead;
    // anonymous requests keep the per-IP 100/min bucket. Page-flipping while
    // logged in can never trip the anonymous budget, and a forged `sub`
    // falls back to the IP bucket (see user-throttle.ts).
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60000, limit: 100, skipIf: skipIfAuthed },
      { ...USER_THROTTLER, skipIf: skipIfAnon, getTracker: userThrottleTracker },
      { ...XP_INTAKE_APP_THROTTLER, getTracker: xpIntakeAppTracker },
      { ...XP_INTAKE_APP_PID_THROTTLER, getTracker: xpIntakeAppPidTracker },
    ]),
    PrismaModule,
    HealthModule,
    AuthModule,
    IdentityModule,
    ProfileModule,
    WalletModule,
    AccountModule,
    AdminModule,
    BatchQueueModule,
    CredentialModule,
    EnvModule,
    ExperienceModule,
    FeeModule,
    FiatModule,
    IntentModule,
    PermissionsModule,
    SessionKeysModule,
    SecurityModule,
    OpenApiModule,
  ],
  providers: [
    // ANT-285(a): the ThrottlerModule limit (100/min default) is inert without
    // a guard. Global guard = secure by default; per-route @Throttle()
    // overrides (e.g. 10/min on OTP/auth) still apply. Least-privilege:
    // every route is rate-limited unless explicitly skipped.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
