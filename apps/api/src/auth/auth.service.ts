import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ms from "ms";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../common/cookies";
import { isPidHandle, normalizePidHandle, toPid } from "../common/pid";
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

/**
 * Absolute session-family caps by login method (rotation preserves the
 * device, so family age = device.createdAt). Google families expire after 7
 * days and must re-authenticate (passkey-first UI); passkey families follow
 * the 30d refresh TTL. Pre-existing rows (authMethod null) count as google.
 */
const GOOGLE_FAMILY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PASSKEY_FAMILY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Google sign-in. Existing credential → reuse its identity (handle ignored).
   * New credential → the caller MUST supply a user-chosen `handle`; it becomes
   * the permanent `<handle>@pid` identity. Never auto-generated, never changed,
   * never reused after delete (deleted rows keep their PK reserved).
   */
  async upsertGoogleIdentity(googleProfile: GoogleProfile, handle?: string) {
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
      if (emailOwner) throw new ConflictException("Email is already linked to another account");
    }

    return this.prisma.$transaction(async (tx) => {
      const normalized = normalizePidHandle(handle ?? "");
      if (!isPidHandle(normalized)) {
        throw new BadRequestException(
          "Choose your permanent PID handle: 3-20 chars, lowercase letters, numbers, underscore. It can never be changed.",
        );
      }
      const pid = toPid(normalized);
      const taken = await tx.identity.findUnique({ where: { pid }, select: { pid: true } });
      if (taken) throw new ConflictException("PID already taken");
      const identity = await tx.identity.create({
        data: { pid, status: "active" },
      });
      await tx.profile.create({
        data: {
          pid: identity.pid,
          displayName: googleProfile.displayName ?? null,
          avatarUrl: googleProfile.photos?.[0]?.value ?? null,
        },
      });
      await tx.identityCredential.create({
        data: {
          provider: "google",
          providerUserId: providerId,
          email,
          pid: identity.pid,
          lastLoginAt: new Date(),
        },
      });
      return identity;
    });
  }

  /** Public availability check for the onboarding handle picker. */
  async isPidAvailable(handle: string): Promise<{ available: boolean; pid: string | null }> {
    const normalized = normalizePidHandle(handle ?? "");
    if (!isPidHandle(normalized)) return { available: false, pid: null };
    const pid = toPid(normalized);
    const taken = await this.prisma.identity.findUnique({ where: { pid }, select: { pid: true } });
    return taken ? { available: false, pid: null } : { available: true, pid };
  }

  async issueSession(
    res: Response,
    pid: string,
    userAgent: string | undefined,
    rotatedFrom?: string,
    authMethod?: "google" | "passkey",
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessTtl = this.config.get<string>("ACCESS_TOKEN_TTL", "15m");
    const refreshTtl = this.config.get<string>("REFRESH_TOKEN_TTL", "30d");

    const accessToken = await this.jwt.signAsync(
      { sub: pid, type: "access" },
      { secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"), expiresIn: accessTtl },
    );
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: pid, jti, type: "refresh" },
      { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"), expiresIn: refreshTtl },
    );

    let deviceId: string;
    if (rotatedFrom) {
      const oldSession = await this.prisma.session.findUnique({ where: { id: rotatedFrom } });
      if (!oldSession) throw new UnauthorizedException("Session not found");
      deviceId = oldSession.deviceId;
      await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    } else {
      const device = await this.prisma.device.create({
        data: { pid, userAgent: userAgent ?? null, authMethod: authMethod ?? null },
      });
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

    const session = await this.prisma.session.findUnique({ where: { id: payload.jti }, include: { device: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Refresh token revoked");
    }

    // Absolute family cap: past it, only a fresh login (passkey-first UI)
    // starts a new family. Checked before revoking so a rejected rotation
    // never burns the still-TTL-valid token.
    const method = session.device.authMethod ?? "google";
    const cap = method === "passkey" ? PASSKEY_FAMILY_MAX_AGE_MS : GOOGLE_FAMILY_MAX_AGE_MS;
    if (Date.now() - session.device.createdAt.getTime() > cap) {
      throw new UnauthorizedException({
        code: "step_up_required",
        message: "Session expired — confirm with your passkey to continue.",
      });
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

  /** Decode a refresh JWT to its session jti (null if invalid). */
  async currentSessionJti(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET") });
      return payload.type === "refresh" ? payload.jti : null;
    } catch {
      return null;
    }
  }

  /** Active sessions for an identity, joined to their device (newest first). */
  async listSessions(pid: string, currentJti: string | null): Promise<
    { id: string; userAgent: string | null; lastSeenAt: Date; createdAt: Date; expiresAt: Date; isCurrent: boolean }[]
  > {
    const sessions = await this.prisma.session.findMany({
      where: { device: { pid }, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { device: true },
      orderBy: { createdAt: "desc" },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.device.userAgent,
      lastSeenAt: s.device.lastSeenAt,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      isCurrent: currentJti != null && s.id === currentJti,
    }));
  }

  /** Revoke every other active session (current refresh jti kept). */
  async revokeOtherSessions(pid: string, currentJti: string | null): Promise<void> {
    await this.prisma.session.updateMany({
      where: { device: { pid }, revokedAt: null, ...(currentJti ? { id: { not: currentJti } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke a single session owned by the identity. */
  async revokeSession(pid: string, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, device: { pid } },
      data: { revokedAt: new Date() },
    });
  }
}
