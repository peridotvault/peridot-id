import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
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
import {
  ACCESS_TOKEN_TTL,
  APP_TOKEN_TTL,
  GOOGLE_FAMILY_MAX_AGE,
  JWT_AUD_APP,
  JWT_AUD_REFRESH,
  JWT_AUD_SESSION,
  JWT_ISSUER,
  PASSKEY_FAMILY_MAX_AGE,
  REFRESH_TOKEN_TTL,
  parseTtlMs,
} from "../common/app-config";
import { isPidHandle, normalizePidHandle, toPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
  /** Present on machine (client-credentials) tokens: the app's clientId. */
  app?: string;
  /** "read" restricts the token to safe (GET) routes — e.g. the SSO exchange token. */
  scope?: string;
  iss: string;
  aud: string;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
  iss: string;
  aud: string;
}

export interface GoogleProfile {
  id: string;
  displayName?: string;
  emails?: { value: string; verified?: boolean }[];
  photos?: { value: string }[];
}

/**
 * Absolute session-family caps by login method (rotation preserves the
 * device, so family age = device.createdAt). Hardcoded via
 * app-config GOOGLE_FAMILY_MAX_AGE / PASSKEY_FAMILY_MAX_AGE (ANT-184).
 * Email-OTP shares the Google cap. Defaults are YouTube-like: months-long rotating cookies, with step-up only
 * past the cap. Pre-existing rows (authMethod null) count as google.
 * Money safety never rests on this: withdrawals/executes/rotation/authorize
 * all need fresh per-action passkey signatures or explicit consent.
 */
// Family caps are hardcoded constants (ANT-184) — see common/app-config.ts.

/**
 * Reuse detection is fail-closed (M2): replaying a revoked refresh token
 * revokes the whole device family, logs a `refresh.reuse_detected` anomaly,
 * and forces a fresh login. There is deliberately NO rotation-race grace on
 * the mint path — a replayed token never yields new tokens. Read paths
 * (session liveness checks, account listing) keep pure live-checks and were
 * never granted a grace window either; the only grace is the stateless one —
 * already-issued access tokens keep working for reads until their 15m expiry.
 */

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  /**
   * Short-lived machine token for an app's backend (client-credentials),
   * bound to the app owner's pid + the app's clientId. Used to read the app's
   * escrow balance, initiate transfers, and manage app settings server-side —
   * no browser session. The token carries `app`, and AdminGuard rejects it.
   * Optional `scope` narrows the token (ANT-286b: `fiat:transfer` for
   * escrow-release least privilege); the scope claim round-trips through
   * JwtStrategy into `AuthenticatedUser.scope`.
   */
  async issueAppAccessToken(ownerPid: string, clientId: string, scope?: string): Promise<{ accessToken: string; expiresIn: string }> {
    // ANT-286b defense in depth (Tobias residual #4): the DTO regex is the
    // first gate, but the service never mints a novel scope even if called
    // directly or behind a pipe that skips validation.
    if (scope !== undefined && scope !== "fiat:transfer") throw new BadRequestException("scope must be fiat:transfer");
    const ttl = APP_TOKEN_TTL;
    const accessToken = await this.jwt.signAsync(
      { sub: ownerPid, type: "access", app: clientId, ...(scope ? { scope } : {}) },
      {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: ttl,
        issuer: JWT_ISSUER,
        audience: JWT_AUD_APP,
      },
    );
    return { accessToken, expiresIn: ttl };
  }

  /**
   * Existing identity for a Google credential, if any (bumps lastLoginAt).
   * Used by the claim flow to tell returning users apart from new ones.
   */
  async findGoogleIdentity(providerUserId: string) {
    return this.findCredentialIdentity("google", providerUserId);
  }

  /**
   * Existing identity for any credential (google | email), if any (bumps
   * lastLoginAt). Email-OTP uses provider "email" with the lowercased email
   * as providerUserId — covered by the same @@unique([provider, providerUserId]).
   */
  async findCredentialIdentity(provider: string, providerUserId: string) {
    const existing = await this.prisma.identityCredential.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      include: { identity: true },
    });
    if (!existing) return null;
    await this.prisma.identityCredential.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
    return existing.identity;
  }

  /**
   * Identity that already owns this verified email, across ANY provider. Since a
   * non-null email is globally unique (one email = one PID), the same person
   * signing in with Google and with email-OTP reconciles here instead of minting
   * a second identity. Not used to persist a second credential — the global
   * email index forbids two rows with the same email.
   */
  async findIdentityByEmail(email: string) {
    const existing = await this.prisma.identityCredential.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
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
    authMethod?: "google" | "email" | "passkey",
    scope?: string | null,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessTtl = ACCESS_TOKEN_TTL;
    const refreshTtl = REFRESH_TOKEN_TTL;

    const accessToken = await this.jwt.signAsync(
      { sub: pid, type: "access" },
      {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: accessTtl,
        issuer: JWT_ISSUER,
        audience: JWT_AUD_SESSION,
      },
    );
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: pid, jti, type: "refresh" },
      {
        secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"),
        expiresIn: refreshTtl,
        issuer: JWT_ISSUER,
        audience: JWT_AUD_REFRESH,
      },
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
      data: {
        id: jti,
        deviceId,
        rotatedFrom: rotatedFrom ?? null,
        // Guarded parse (ANT-227 item 4): a typo'd TTL must throw here, never
        // persist an Invalid-Date session row.
        expiresAt: new Date(Date.now() + parseTtlMs(refreshTtl, "REFRESH_TOKEN_TTL")),
      },
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

  /** Verify options every refresh-token check must use (secret + iss + aud). */
  private refreshVerifyOptions(): { secret: string; issuer: string; audience: string } {
    return {
      secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"),
      issuer: JWT_ISSUER,
      audience: JWT_AUD_REFRESH,
    };
  }

  async rotateSession(req: Request, res: Response, scope: string | null = null): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = scope ? cookies?.[scopeRefreshCookie(scope)] : cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException("Missing refresh token");

    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync(token, this.refreshVerifyOptions());
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (payload.type !== "refresh") throw new UnauthorizedException("Invalid refresh token");

    const session = await this.prisma.session.findUnique({ where: { id: payload.jti }, include: { device: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      // Fail-closed reuse detection (M2): a presented token whose session is
      // already revoked means the token was replayed after rotation/logout —
      // the classic stolen-refresh-token signal. Nuke the whole device family
      // (all sessions on the compromised device), log the anomaly, and force
      // a fresh login. No new tokens are minted on this path, ever.
      // (Expired-but-never-revoked and unknown jtis are lifecycle noise, not
      // theft signals: plain 401, no family revocation.)
      if (session?.revokedAt && session.device) {
        await this.prisma.session.updateMany({
          where: { deviceId: session.deviceId },
          data: { revokedAt: new Date() },
        });
        await this.security.log(session.device.pid, "refresh.reuse_detected", {
          deviceId: session.deviceId,
          jti: payload.jti,
          // F4 SOC triage: a replay seconds after rotation from the same UA is
          // an organic multi-tab race; a replay long after rotation (or from a
          // UA that never matches the device) is the theft-driven signal. Both
          // fields make the alert query below able to tell them apart.
          revokedAgoMs: Date.now() - session.revokedAt.getTime(),
          userAgent: req.headers["user-agent"] ?? null,
        });
        throw new UnauthorizedException("Session compromised — sign in again.");
      }
      throw new UnauthorizedException("Refresh token revoked");
    }

    // Absolute family cap: past it, only a fresh login (passkey-first UI)
    // starts a new family. Checked before revoking so a rejected rotation
    // never burns the still-TTL-valid token.
    const method = session.device.authMethod ?? "google";
    // Hardcoded constants, validated at import (ANT-227 item 4) — a typo
    // breaks the build, it can never silently disable the cap.
    const cap =
      method === "passkey"
        ? parseTtlMs(PASSKEY_FAMILY_MAX_AGE, "PASSKEY_FAMILY_MAX_AGE")
        : parseTtlMs(GOOGLE_FAMILY_MAX_AGE, "GOOGLE_FAMILY_MAX_AGE");
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
        const payload = await this.jwt.verifyAsync(token, this.refreshVerifyOptions());
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
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, this.refreshVerifyOptions());
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
      {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: ACCESS_TOKEN_TTL,
        issuer: JWT_ISSUER,
        audience: JWT_AUD_SESSION,
      },
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
      const payload = await this.jwt.verifyAsync(token, this.refreshVerifyOptions());
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
