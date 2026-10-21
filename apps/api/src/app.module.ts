import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AccountModule } from "./account/account.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { CredentialModule } from "./credentials/credential.module";
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
    ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }]),
    PrismaModule,
    HealthModule,
    AuthModule,
    IdentityModule,
    ProfileModule,
    WalletModule,
    AccountModule,
    AdminModule,
    CredentialModule,
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
