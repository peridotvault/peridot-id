import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ms from "ms";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../common/cookies";
import { newPid } from "../common/pid";
import { generateUsername } from "../common/username";
import { PrismaService } from "../prisma/prisma.service";

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
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async upsertGoogleIdentity(googleProfile: GoogleProfile) {
    const providerId = googleProfile.id;
    const existing = await this.prisma.identityCredential.findUnique({
      where: { provider_providerUserId: { provider: "google", providerUserId: providerId } },
      include: { identity: true },
    });
    if (existing) {
      await this.prisma.identityCredential.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
      return existing.identity;
    }

    const email = googleProfile.emails?.[0]?.value ?? null;
    if (email) {
      const emailOwner = await this.prisma.identityCredential.findFirst({
        where: { email },
        select: { id: true },
      });
      if (emailOwner) throw new ConflictException("Email sudah terhubung dengan akun lain");
    }

    return this.prisma.$transaction(async (tx) => {
      const username = await generateUsername(tx, googleProfile.displayName);
      const identity = await tx.identity.create({
        data: { id: newPid(), status: "active" },
      });
      await tx.profile.create({
        data: {
          identityId: identity.id,
          username,
          displayName: googleProfile.displayName ?? null,
          avatarUrl: googleProfile.photos?.[0]?.value ?? null,
        },
      });
      await tx.identityCredential.create({
        data: {
          provider: "google",
          providerUserId: providerId,
          email,
          identityId: identity.id,
          lastLoginAt: new Date(),
        },
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

    const session = await this.prisma.session.findUnique({ where: { id: payload.jti } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Refresh token revoked");
    }

    await this.prisma.session.update({ where: { id: payload.jti }, data: { revokedAt: new Date() } });

    await this.issueSession(res, payload.sub, req.headers["user-agent"], payload.jti);
  }

  async logout(req: Request, res: Response): Promise<void> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET") });
        await this.prisma.session.updateMany({ where: { id: payload.jti }, data: { revokedAt: new Date() } });
      } catch {
        // already invalid, just clear
      }
    }
    clearAuthCookies(res, this.config);
  }
}
