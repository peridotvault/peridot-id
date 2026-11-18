import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { CredentialModule } from "../credentials/credential.module";
import { SecurityModule } from "../security/security-event.module";
import { UsageModule } from "../usage/usage.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { ClaimService } from "./claim.service";
import { EmailOtpService } from "./email/email-otp.service";
import { EmailService } from "./email/email.service";
import { PidAppsController } from "./apps.controller";
import { PidAppsService } from "./apps.service";
import { GoogleGuard } from "./google.guard";
import { GOOGLE_OAUTH_OPTIONS, googleOAuthOptionsFactory, GoogleStrategy } from "./google.strategy";
import { JwtStrategy } from "./jwt.strategy";
import { SsoService } from "./sso.service";
import { WalletAuthController } from "./wallet/wallet-auth.controller";
import { WalletAuthService } from "./wallet/wallet-auth.service";

@Module({
  imports: [
    PassportModule.register({ session: false }),
    JwtModule.register({}),
    CredentialModule,
    SecurityModule,
    UsageModule,
  ],
  controllers: [AuthController, PidAppsController, WalletAuthController],
  providers: [
    AuthService,
    ClaimService,
    WalletAuthService,
    EmailOtpService,
    EmailService,
    PidAppsService,
    SsoService,
    JwtStrategy,
    GoogleGuard,
    {
      provide: GOOGLE_OAUTH_OPTIONS,
      useFactory: googleOAuthOptionsFactory,
      inject: [ConfigService],
    },
    {
      provide: GoogleStrategy,
      useFactory: (options, authService) => (options ? new GoogleStrategy(options, authService) : undefined),
      inject: [GOOGLE_OAUTH_OPTIONS, AuthService],
    },
  ],
  exports: [AuthService, SsoService, PidAppsService],
})
export class AuthModule {}
