import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { CredentialModule } from "../credentials/credential.module";
import { SecurityModule } from "../security/security-event.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PidAppsController } from "./apps.controller";
import { PidAppsService } from "./apps.service";
import { GoogleGuard } from "./google.guard";
import { GOOGLE_OAUTH_OPTIONS, googleOAuthOptionsFactory, GoogleStrategy } from "./google.strategy";
import { JwtStrategy } from "./jwt.strategy";
import { SsoService } from "./sso.service";

@Module({
  imports: [
    PassportModule.register({ session: false }),
    JwtModule.register({}),
    CredentialModule,
    SecurityModule,
  ],
  controllers: [AuthController, PidAppsController],
  providers: [
    AuthService,
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
  exports: [AuthService, SsoService],
})
export class AuthModule {}
