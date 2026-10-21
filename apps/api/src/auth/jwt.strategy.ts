import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { cookieExtractor } from "../common/jwt-auth.guard";
import { JWT_ACCESS_AUDIENCES, JWT_ISSUER, resolveServiceUrls } from "../common/app-config";
import { AuthenticatedUser } from "../common/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { AccessTokenPayload } from "./auth.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService, private readonly prisma: PrismaService) {
    // Wallet origin (WALLET_URL, deprecated CLIENT_SUCCESS_URL fallback)
    // restricts the unscoped wallet session to the wallet's own origin.
    const walletUrl = resolveServiceUrls((key, def) => config.get(key, def)).walletUrl;
    let walletOrigin: string | null = null;
    try {
      walletOrigin = new URL(walletUrl).origin;
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
      // ANT-227 item 1: issuer + per-class audience enforced at verify time,
      // so a refresh/app/sso token can never validate as a session token.
      issuer: JWT_ISSUER,
      audience: [...JWT_ACCESS_AUDIENCES],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.type !== "access") throw new UnauthorizedException("Invalid token type");
    // Belt-and-braces: passport-jwt already enforced iss/aud above, but an
    // explicitly-constructed strategy (tests, alternate wiring) must fail
    // closed too when claims are missing or foreign.
    if (payload.iss !== JWT_ISSUER) throw new UnauthorizedException("Invalid token issuer");
    if (!(JWT_ACCESS_AUDIENCES as readonly string[]).includes(payload.aud)) {
      throw new UnauthorizedException("Invalid token audience");
    }
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
