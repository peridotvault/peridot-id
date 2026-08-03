import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ms from "ms";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../common/cookies";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
}

export interface GoogleProfile {
  id: string;
  displayName?: string;
  emails?: { value: string }[];
  photos?: { value: string }[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async upsertGoogleIdentity(googleProfile: GoogleProfile) {
    const providerId = googleProfile.id;
    const existing = await this.prisma.authAccount.findUnique({
      where: { provider_providerId: { provider: "google", providerId } },
      include: { identity: true },
    });
    if (existing) return existing.identity;

    return this.prisma.$transaction(async (tx) => {
      const identity = await tx.identity.create({ data: {} });
      await tx.profile.create({
        data: {
          identityId: identity.id,
          displayName: googleProfile.displayName ?? null,
          avatarUrl: googleProfile.photos?.[0]?.value ?? null,
        },
      });
      await tx.authAccount.create({
        data: { provider: "google", providerId, email: googleProfile.emails?.[0]?.value ?? null, identityId: identity.id },
      });
      return identity;
    });
  }

  async issueSession(
    res: Response,
    identityId: string,
    userAgent: string | undefined,
    rotatedFrom?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessTtl = this.config.get<string>("ACCESS_TOKEN_TTL", "15m");
    const refreshTtl = this.config.get<string>("REFRESH_TOKEN_TTL", "30d");

    const accessToken = await this.jwt.signAsync(
      { sub: identityId, type: "access" },
      { secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"), expiresIn: accessTtl },
    );
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: identityId, jti, type: "refresh" },
      { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"), expiresIn: refreshTtl },
    );

    await this.redis.set(`rt:${jti}`, identityId, "EX", Math.floor(ms(refreshTtl) / 1000));

    let deviceId: string;
    if (rotatedFrom) {
      const oldSession = await this.prisma.session.findUnique({ where: { id: rotatedFrom } });
      if (!oldSession) throw new UnauthorizedException("Session not found");
      deviceId = oldSession.deviceId;
      await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    } else {
      const device = await this.prisma.device.create({ data: { identityId, userAgent: userAgent ?? null } });
      deviceId = device.id;
    }

    await this.prisma.session.create({
      data: { id: jti, deviceId, rotatedFrom: rotatedFrom ?? null, expiresAt: new Date(Date.now() + ms(refreshTtl)) },
    });

    setAuthCookies(res, this.config, accessToken, refreshToken);
    return { accessToken, refreshToken };
  }

  async rotateSession(req: Request, res: Response): Promise<void> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException("Missing refresh token");

    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET") });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (payload.type !== "refresh") throw new UnauthorizedException("Invalid refresh token");

    const stored = await this.redis.get(`rt:${payload.jti}`);
    if (stored !== payload.sub) throw new UnauthorizedException("Refresh token revoked");

    await this.redis.del(`rt:${payload.jti}`);
    await this.prisma.session.updateMany({ where: { id: payload.jti }, data: { revokedAt: new Date() } });

    await this.issueSession(res, payload.sub, req.headers["user-agent"], payload.jti);
  }

  async logout(req: Request, res: Response): Promise<void> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET") });
        await this.redis.del(`rt:${payload.jti}`);
        await this.prisma.session.updateMany({ where: { id: payload.jti }, data: { revokedAt: new Date() } });
      } catch {
        // already invalid, just clear
      }
    }
    clearAuthCookies(res, this.config);
  }
}
