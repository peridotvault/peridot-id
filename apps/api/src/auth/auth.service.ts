import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ms from "ms";
import {
  accountRefreshCookieName,
  accountRefreshCookieNames,
  clearAccountRefreshCookie,
  clearAuthCookies,
  clearScopedAuthCookies,
  REFRESH_COOKIE,
  scopeRefreshCookie,
  setActiveAuthCookies,
  setAuthCookies,
  setScopedAuthCookies,
} from "../common/cookies";
import { isPidHandle, normalizePidHandle, toPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
  /** Present on machine (client-credentials) tokens: the app's clientId. */
  app?: string;
  /** "read" restricts the token to safe (GET) routes — e.g. the SSO exchange token. */
  scope?: string;
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
 * device, so family age = device.createdAt). Overridable via
 * GOOGLE_FAMILY_MAX_AGE / PASSKEY_FAMILY_MAX_AGE (ms-parseable, e.g. "90d").
 * Defaults are YouTube-like: months-long rotating cookies, with step-up only
 * past the cap. Pre-existing rows (authMethod null) count as google.
 * Money safety never rests on this: withdrawals/executes/rotation/authorize
 * all need fresh per-action passkey signatures or explicit consent.
 */
const DEFAULT_GOOGLE_FAMILY_MAX_AGE = "90d";
const DEFAULT_PASSKEY_FAMILY_MAX_AGE = "365d";

/**
 * Grace window for the multi-tab rotation race: two tabs refreshing with the
 * same token near-simultaneously must not log one of them out. The loser
 * follows the already-issued child (via the rotatedFrom link) instead of
 * throwing. No schema change — the link column already exists.
 */
const ROTATION_GRACE_MS = 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Short-lived machine token for an app's backend (client-credentials),
   * bound to the app owner's pid + the app's clientId. Used to read the app's
   * escrow balance, initiate transfers, and manage app settings server-side —
   * no browser session. The token carries `app`, and AdminGuard rejects it.
   */
  async issueAppAccessToken(ownerPid: string, clientId: string): Promise<{ accessToken: string; expiresIn: string }> {
    const ttl = this.config.get<string>("APP_TOKEN_TTL", "1h");
    const accessToken = await this.jwt.signAsync(
      { sub: ownerPid, type: "access", app: clientId },
      { secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"), expiresIn: ttl },
    );
    return { accessToken, expiresIn: ttl };
  }

  /**
   * Existing identity for a Google credential, if any (bumps lastLoginAt).
   * Used by the claim flow to tell returning users apart from new ones.
   */
  async findGoogleIdentity(providerUserId: string) {
    const existing = await this.prisma.identityCredential.findUnique({
      where: { provider_providerUserId: { provider: "google", providerUserId } },
      include: { identity: true },
    });
    if (!existing) return null;
    await this.prisma.identityCredential.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
    return existing.identity;
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
    scope?: string | null,
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

    if (scope) {
      // Client app gets its own session cookies, separate from the wallet's.
      setScopedAuthCookies(res, this.config, scope, accessToken, refreshToken);
    } else {
      setAuthCookies(res, this.config, accessToken, refreshToken, pid);
    }
    return { accessToken, refreshToken };
  }

  /**
   * Mint an independent session for a first-party client app (carries its own
   * cookies + session row). The wallet's session is untouched, so logging out of
   * either side never logs out the other.
   */
  async grantAppSession(res: Response, pid: string, scope: string, userAgent: string | undefined): Promise<void> {
    await this.issueSession(res, pid, userAgent, undefined, undefined, scope);
  }

  async rotateSession(req: Request, res: Response, scope: string | null = null): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = scope ? cookies?.[scopeRefreshCookie(scope)] : cookies?.[REFRESH_COOKIE];
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
      // Rotation race: this token was already rotated moments ago (another
      // tab won). Follow the live child instead of logging the user out.
      // Anything older than the grace window still fails closed.
      const child = !session
        ? null
        : await this.prisma.session.findFirst({
            where: {
              rotatedFrom: payload.jti,
              revokedAt: null,
              expiresAt: { gt: new Date() },
              createdAt: { gt: new Date(Date.now() - ROTATION_GRACE_MS) },
            },
            include: { device: true },
          });
      if (!child?.device) throw new UnauthorizedException("Refresh token revoked");
      // Chain from the child: the family keeps a single live head, so the
      // grace path never forks a second valid chain. (The winner passed the
      // family-cap check <60s ago when it rotated, so no re-check here.)
      await this.prisma.session.update({ where: { id: child.id }, data: { revokedAt: new Date() } });
      await this.issueSession(res, payload.sub, req.headers["user-agent"], child.id, undefined, scope);
      return;
    }

    // Absolute family cap: past it, only a fresh login (passkey-first UI)
    // starts a new family. Checked before revoking so a rejected rotation
    // never burns the still-TTL-valid token.
    const method = session.device.authMethod ?? "google";
    // Unparseable env falls back to the default (NaN is falsy) — a typo must
    // never silently disable the cap.
    const cap =
      method === "passkey"
        ? ms(this.config.get<string>("PASSKEY_FAMILY_MAX_AGE", DEFAULT_PASSKEY_FAMILY_MAX_AGE)) ||
          ms(DEFAULT_PASSKEY_FAMILY_MAX_AGE)
        : ms(this.config.get<string>("GOOGLE_FAMILY_MAX_AGE", DEFAULT_GOOGLE_FAMILY_MAX_AGE)) ||
          ms(DEFAULT_GOOGLE_FAMILY_MAX_AGE);
    if (Date.now() - session.device.createdAt.getTime() > cap) {
      throw new UnauthorizedException({
        code: "step_up_required",
        message: "Session expired — confirm with your passkey to continue.",
      });
    }

    await this.prisma.session.update({ where: { id: payload.jti }, data: { revokedAt: new Date() } });

    await this.issueSession(res, payload.sub, req.headers["user-agent"], payload.jti, undefined, scope);
  }

  async logout(req: Request, res: Response, scope: string | null = null): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = scope ? cookies?.[scopeRefreshCookie(scope)] : cookies?.[REFRESH_COOKIE];
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET") });
        await this.prisma.session.updateMany({ where: { id: payload.jti }, data: { revokedAt: new Date() } });
        // Signing out the active identity also drops it from the account list.
        if (!scope) clearAccountRefreshCookie(res, this.config, payload.sub);
      } catch {
        // already invalid, just clear
      }
    }
    if (scope) clearScopedAuthCookies(res, this.config, scope);
    else clearAuthCookies(res, this.config);
  }

  /** Decode a refresh JWT to its identity + session jti (null if invalid). */
  private async verifyRefresh(token: string): Promise<{ pid: string; jti: string } | null> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"),
      });
      if (payload.type !== "refresh") return null;
      return { pid: payload.sub, jti: payload.jti };
    } catch {
      return null;
    }
  }

  private async sessionLive(jti: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({ where: { id: jti } });
    return !!session && !session.revokedAt && session.expiresAt > new Date();
  }

  /**
   * Identities with a live session in this browser (wallet account switcher).
   * Sourced from the per-identity refresh cookies; the active identity is
   * whichever `pid_refresh` currently holds. Legacy single-session browsers
   * (no per-identity cookie yet) report just the active identity.
   */
  async listAccounts(req: Request): Promise<
    { pid: string; displayName: string | null; avatarUrl: string | null; isActive: boolean }[]
  > {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const active = cookies[REFRESH_COOKIE] ? await this.verifyRefresh(cookies[REFRESH_COOKIE]) : null;
    const tokens = accountRefreshCookieNames(cookies).map((n) => cookies[n]);
    if (tokens.length === 0 && cookies[REFRESH_COOKIE]) tokens.push(cookies[REFRESH_COOKIE]);

    const seen = new Set<string>();
    const accounts: { pid: string; displayName: string | null; avatarUrl: string | null; isActive: boolean }[] = [];
    for (const token of tokens) {
      const v = await this.verifyRefresh(token);
      if (!v || seen.has(v.pid) || !(await this.sessionLive(v.jti))) continue;
      seen.add(v.pid);
      const profile = await this.prisma.profile.findUnique({ where: { pid: v.pid } });
      accounts.push({
        pid: v.pid,
        displayName: profile?.displayName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        isActive: active?.pid === v.pid,
      });
    }
    return accounts.sort((a, b) => (a.isActive === b.isActive ? a.pid.localeCompare(b.pid) : a.isActive ? -1 : 1));
  }

  /**
   * Make a linked identity active without re-authenticating: re-issue the
   * active access cookie from that identity's own (httpOnly) refresh cookie.
   */
  async switchAccount(req: Request, res: Response, pid: string): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[accountRefreshCookieName(pid)];
    if (!token) throw new UnauthorizedException("No session for that account");
    const v = await this.verifyRefresh(token);
    if (!v || v.pid !== pid || !(await this.sessionLive(v.jti))) {
      throw new UnauthorizedException("Account session expired — sign in again");
    }
    const accessToken = await this.jwt.signAsync(
      { sub: pid, type: "access" },
      { secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"), expiresIn: this.config.get<string>("ACCESS_TOKEN_TTL", "15m") },
    );
    setActiveAuthCookies(res, this.config, accessToken, token);
  }

  /** Forget one identity in this browser and revoke its session. */
  async signOutAccount(req: Request, res: Response, pid: string): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[accountRefreshCookieName(pid)];
    if (token) {
      const v = await this.verifyRefresh(token);
      if (v) await this.prisma.session.updateMany({ where: { id: v.jti }, data: { revokedAt: new Date() } });
    }
    clearAccountRefreshCookie(res, this.config, pid);
    const active = cookies[REFRESH_COOKIE] ? await this.verifyRefresh(cookies[REFRESH_COOKIE]) : null;
    if (active?.pid === pid) clearAuthCookies(res, this.config);
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
