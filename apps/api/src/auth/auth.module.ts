import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { GoogleGuard } from "./google.guard";
import { GOOGLE_OAUTH_OPTIONS, googleOAuthOptionsFactory, GoogleStrategy } from "./google.strategy";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule.register({ session: false }),
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
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
  exports: [AuthService],
})
export class AuthModule {}
