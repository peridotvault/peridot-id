import { ProvidersController } from "./providers.controller";
import { ProvidersService } from "./providers.service";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { googleCallbackUrl, resolveServiceUrls } from "../common/app-config";
import { CredentialModule } from "../credentials/credential.module";
import { SecurityModule } from "../security/security-event.module";
import { UsageModule } from "../usage/usage.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { ClaimService } from "./claim.service";
import { EmailOtpService } from "./email/email-otp.service";
import { EmailService } from "./email/email.service";
import { WasabiStorageService } from "../common/wasabi-storage";
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
  controllers: [ProvidersController, AuthController, PidAppsController, WalletAuthController],
  providers: [
    ProvidersService,
    AuthService,
    ClaimService,
    WalletAuthService,
    EmailOtpService,
    EmailService,
    PidAppsService,
    WasabiStorageService,
    SsoService,
    JwtStrategy,
    GoogleGuard,
    {
      provide: GOOGLE_OAUTH_OPTIONS,
      useFactory: googleOAuthOptionsFactory,
      inject: [ConfigService],
    },
    {
      // Always registered: the guard may load platform credentials from the
      // admin catalogue even when the env client is absent.
      provide: GoogleStrategy,
      useFactory: (options: import("./google.strategy").GoogleOAuthOptions | null, authService: AuthService, config: ConfigService) =>
        new GoogleStrategy(
          options ?? {
            // passport-oauth2 rejects an empty clientID at construction. The
            // guard replaces these per request and fails closed when neither a
            // DB row nor the env client is configured.
            clientID: "unconfigured",
            clientSecret: "unconfigured",
            callbackURL: googleCallbackUrl(resolveServiceUrls((key, def) => config.get(key, def)).apiUrl),
          },
          authService,
        ),
      inject: [GOOGLE_OAUTH_OPTIONS, AuthService, ConfigService],
    },
  ],
  exports: [AuthService, SsoService, PidAppsService],
})
export class AuthModule {}
