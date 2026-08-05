import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { cookieExtractor } from "../common/jwt-auth.guard";
import { AuthenticatedUser } from "../common/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { AccessTokenPayload } from "./auth.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService, private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.type !== "access") throw new UnauthorizedException("Invalid token type");
    const identity = await this.prisma.identity.findUnique({
      where: { id: payload.sub },
      select: { status: true },
    });
    if (!identity || identity.status !== "active") throw new UnauthorizedException("Identity tidak aktif");
    return { identityId: payload.sub };
  }
}
