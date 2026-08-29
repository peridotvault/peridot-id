import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { AccountModule } from "./account/account.module";
import { AuthModule } from "./auth/auth.module";
import { CredentialModule } from "./credentials/credential.module";
import { IdentityModule } from "./identity/identity.module";
import { IntentModule } from "./intent/intent.module";
import { OpenApiModule } from "./openapi/openapi.module";
import { ProfileModule } from "./profile/profile.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SecurityModule } from "./security/security-event.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    IdentityModule,
    ProfileModule,
    WalletModule,
    AccountModule,
    CredentialModule,
    IntentModule,
    SecurityModule,
    OpenApiModule,
  ],
})
export class AppModule {}
