import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { cookieExtractor } from "../common/jwt-auth.guard";
import { AuthenticatedUser } from "../common/current-user.decorator";
import { AccessTokenPayload } from "./auth.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    if (payload.type !== "access") throw new UnauthorizedException("Invalid token type");
    return { identityId: payload.sub };
  }
}
