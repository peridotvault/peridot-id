import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { IdentityModule } from "./identity/identity.module";
import { OpenApiModule } from "./openapi/openapi.module";
import { ProfileModule } from "./profile/profile.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60000, limit: 100 }]),
    PrismaModule,
    RedisModule,
    AuthModule,
    IdentityModule,
    ProfileModule,
    OpenApiModule,
  ],
})
export class AppModule {}
