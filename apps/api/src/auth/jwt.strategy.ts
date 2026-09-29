import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { cookieExtractor } from "../common/jwt-auth.guard";
import { AuthenticatedUser } from "../common/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { AccessTokenPayload } from "./auth.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService, private readonly prisma: PrismaService) {
    const successUrl = config.get<string>("CLIENT_SUCCESS_URL");
    let walletOrigin: string | null = null;
    try {
      walletOrigin = successUrl ? new URL(successUrl).origin : null;
    } catch {
      walletOrigin = null;
    }
    super({
      // Cookie (browser session) or Bearer (machine/client-credentials token).
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => cookieExtractor(req, walletOrigin),
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.type !== "access") throw new UnauthorizedException("Invalid token type");
    const identity = await this.prisma.identity.findUnique({
      where: { pid: payload.sub },
      select: { status: true },
    });
    if (!identity || identity.status !== "active") throw new UnauthorizedException("Identity is not active");
    return {
      pid: payload.sub,
      ...(payload.app ? { app: payload.app } : {}),
      ...(payload.scope ? { scope: payload.scope } : {}),
    };
  }
}
