// Self-serve OAuth client registry ("Sign in with PeridotID"). Any logged-in identity
// can register an app and get a public client_id; PeridotID only returns pid_codes to
// the app's registered redirect URIs. CORS origins are derived from those URIs.

import { Prisma } from "@prisma/client";
import type { AppUsersPage } from "@peridotvault/pid-types";
import { BadRequestException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { APP_CLIENT_SECRET_GRACE, APP_CLIENT_SECRET_MAX_AGE, parseTtlMs } from "../common/app-config";
import { encryptSecret } from "../common/secret-crypto";
import { proxyLogoUrl, WasabiStorageService, type UploadFile } from "../common/wasabi-storage";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

/**
 * Normalize a developer-supplied origin: strip trailing slashes, reject anything
 * that isn't a bare http(s) origin (no path, query, or fragment).
 *
 * ANT-826 F1 (layer 2): wildcards are rejected even if a caller bypasses DTO
 * validation. Any `*` anywhere in the raw value throws `origin_wildcard`.
 */
export function normalizeOrigin(value: string): string {
  // Hostnames are case-insensitive; lowercase the whole bare origin (no path allowed).
  if (value.includes("*")) throw new Error("origin_wildcard");
  const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
  if (trimmed.includes("*")) throw new Error("origin_wildcard");
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("origin_not_http");
  if (parsed.origin !== trimmed) throw new Error("origin_not_bare");
  if (parsed.hostname.includes("*")) throw new Error("origin_wildcard");
  return parsed.origin;
}

const PROVIDER_INCLUDE = { providerSettings: { include: { provider: true } } } as const;
function withLoginMethods<T extends object>(row: T) {
  const { providerSettings, ...rest } = row as T & { providerSettings?: Array<{ providerCode: string; provider: { isAvailable: boolean } }> };
  return { ...rest, loginMethods: (providerSettings ?? []).filter(x => x.provider.isAvailable).map(x => x.providerCode) };
}

@Injectable()
export class PidAppsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly security?: SecurityEventService,
    @Optional() private readonly wasabi?: WasabiStorageService,
  ) {}

  /** Ownership is checked before reading any user rows, including search/count. */
  async users(ownerPid: string, id: string, q = "", page = 1): Promise<AppUsersPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || q.length > 100) {
      throw new BadRequestException("Invalid user search or page");
    }
    const app = await this.get(ownerPid, id);
    const where = { appClientId: app.clientId, ...(q.trim() ? { pid: { contains: q.trim().toLowerCase() } } : {}) };
    const pageSize = 25;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.appUser.findMany({ where, orderBy: { pid: "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.appUser.count({ where }),
    ]);
    const profiles = await this.prisma.profile.findMany({
      where: { pid: { in: rows.map(row => row.pid) } }, select: { pid: true, displayName: true },
    });
    // One indexed lookup per visible PID; never load another app's history.
    const latest = rows.length ? await this.prisma.$queryRaw<Array<{ pid: string; code: string | null; name: string | null; evidence: string }>>`
      SELECT u.pid, p.code, p.name, e."providerEvidence" AS evidence
      FROM app_users u
      LEFT JOIN LATERAL (
        SELECT "providerCode", "providerEvidence" FROM login_events
        WHERE "appId"=${id} AND pid=u.pid ORDER BY "occurredAt" DESC, id DESC LIMIT 1
      ) e ON true LEFT JOIN providers p ON p.code=e."providerCode"
      WHERE u."appClientId"=${app.clientId} AND u.pid IN (${Prisma.join(rows.map(row => row.pid))})` : [];
    const providers = new Map(latest.map(event => [event.pid, event]));
    const names = new Map(profiles.map(profile => [profile.pid, profile.displayName]));
    return { total, page, pageSize, users: rows.map(row => ({
      pid: row.pid, displayName: names.get(row.pid) ?? null,
      lastLoginProvider: providers.get(row.pid)?.code ? {
        code: providers.get(row.pid)!.code!, name: providers.get(row.pid)!.name!,
        evidence: providers.get(row.pid)!.evidence as "server" | "client_selected",
      } : null,
      firstLoginAt: row.firstLoginAt.toISOString(), lastLoginAt: row.lastLoginAt.toISOString(),
    })) };
  }

  /**
   * Immutable verification-audit write. Tolerant of delegates that lack the
   * model (older generated clients / unit-test doubles).
   */
  private async auditVerification(data: Record<string, unknown>): Promise<void> {
    const prisma = this.prisma as unknown as {
      pidVerificationAudit?: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    };
    await prisma.pidVerificationAudit?.create({ data }).catch(() => null);
  }

  /**
   * ANT-804 D3: effective verification. Grants expire — an expired grant
   * behaves as unverified everywhere (fee waiver dies with it) without a
   * cron job. Callers must use this instead of reading `isVerified` raw.
   */
  static isVerificationActive(app: { isVerified: boolean; verificationExpiresAt?: Date | string | null } | null | undefined): boolean {
    if (!app?.isVerified) return false;
    if (!app.verificationExpiresAt) return true;
    return new Date(app.verificationExpiresAt).getTime() > Date.now();
  }

  /** Never expose secret material in API responses (hash or plaintext). */
  private static readonly PUBLIC_OMIT = {
    webhookSecret: true,
    clientSecretHash: true,
    prevClientSecretHash: true,
  } as const;

  /**
   * Server pepper for client-secret hashes (ANT-227 item 5). Optional env
   * `PID_APP_SECRET_PEPPER`: when set, hashes are `sha256(pepper:secret)` so
   * a read-only DB leak alone can't be brute-forced offline. Pre-pepper
   * `sha256(secret)` rows keep verifying (legacy path) until rotated — rotate
   * to upgrade a hash to the peppered form.
   */
  private pepper(): string {
    return this.config?.get<string>("PID_APP_SECRET_PEPPER", "") ?? "";
  }

  async create(ownerPid: string, name: string, allowedOrigins: string[] = []) {
    const clientId = `pidapp_${randomBytes(16).toString("hex")}`;
    // ANT-804 D3.1 deny-by-default: self-serve registration NEVER produces a
    // verified app, even if a caller smuggles isVerified into the payload.
    // Verification is an admin-recorded grant only (AdminService).
    return withLoginMethods(await this.prisma.pidApp.create({
      data: { clientId, ownerPid, name, isVerified: false, allowedOrigins: [...new Set(allowedOrigins.map(normalizeOrigin))] },
      omit: PidAppsService.PUBLIC_OMIT,
      include: PROVIDER_INCLUDE,
    }));
  }

  async list(ownerPid: string) {
    return (await this.prisma.pidApp.findMany({ where: { ownerPid }, orderBy: { createdAt: "desc" }, omit: PidAppsService.PUBLIC_OMIT, include: PROVIDER_INCLUDE })).map(withLoginMethods);
  }

  /** Upload an app logo (owner only). Stored under a content-hashed key, so the
   *  logo proxy's immutable cache never serves a replaced image. */
  async setLogo(ownerPid: string, id: string, file: UploadFile) {
    const app = await this.ownedApp(ownerPid, id);
    if (!this.wasabi) throw new ServiceUnavailableException("Logo upload is not configured");
    const key = await this.wasabi.putAppLogo(app.clientId, file);
    const logoUrl = proxyLogoUrl(this.apiBase(), key);
    if (!logoUrl) throw new ServiceUnavailableException("API_URL is not configured");
    return withLoginMethods(
      await this.prisma.pidApp.update({
        where: { id },
        data: { logoUrl },
        omit: PidAppsService.PUBLIC_OMIT,
        include: PROVIDER_INCLUDE,
      }),
    );
  }

  private apiBase(): string {
    return (this.config?.get<string>("API_URL") ?? process.env.API_URL ?? "").trim();
  }

  /** One owned app (404 for anyone else — never leak another owner's app). */
  async get(ownerPid: string, id: string) {
    const app = await this.ownedApp(ownerPid, id);
    const { webhookSecret: _s, clientSecretHash: _h, prevClientSecretHash: _p, ...safe } = app;
    return safe;
  }

  async update(ownerPid: string, id: string, patch: { name?: string; logoUrl?: string; description?: string; allowedOrigins?: string[]; isActive?: boolean; isVerified?: boolean; loginMethods?: string[] }) {
    const app = await this.ownedApp(ownerPid, id);
    // ANT-804 D3.3 (negative): self-serve update can never set isVerified —
    // a smuggled field is stripped (ignored, not trusted). Admin grants flow
    // through AdminService.grantVerification only.
    const { isVerified: _dropped, ...safePatch } = patch;
    void _dropped;
    const nextOrigins = safePatch.allowedOrigins !== undefined
      ? [...new Set(safePatch.allowedOrigins.map(normalizeOrigin))]
      : undefined;
    // ANT-804 D3 edge 7: origins change on a verified app forces re-review —
    // the waiver dies immediately until an admin re-grants.
    const originsChanged = nextOrigins !== undefined &&
      JSON.stringify([...(app.allowedOrigins as string[] ?? [])].sort()) !== JSON.stringify([...nextOrigins].sort());
    const mustRevoke = originsChanged && PidAppsService.isVerificationActive(app as never);
    if (safePatch.loginMethods !== undefined) {
      const methods = [...new Set(safePatch.loginMethods)];
      const available = await this.prisma.loginProvider.count({ where: { code: { in: methods }, isAvailable: true } });
      if (!methods.length || available !== methods.length) throw new BadRequestException("Select at least one available provider");
    }
    const updated = await this.prisma.pidApp.update({
      where: { id },
      data: {
        ...(safePatch.name !== undefined ? { name: safePatch.name } : {}),
        ...(safePatch.logoUrl !== undefined ? { logoUrl: safePatch.logoUrl.trim() || null } : {}),
        ...(safePatch.description !== undefined ? { description: safePatch.description.trim() || null } : {}),
        ...(nextOrigins !== undefined ? { allowedOrigins: nextOrigins } : {}),
        ...(safePatch.isActive !== undefined ? { isActive: safePatch.isActive } : {}),
        ...(safePatch.loginMethods !== undefined ? { providerSettings: { deleteMany: {}, create: [...new Set(safePatch.loginMethods)].map(providerCode => ({ providerCode })) } } : {}),
        ...(mustRevoke ? { isVerified: false } : {}),
      },
      omit: PidAppsService.PUBLIC_OMIT,
      include: PROVIDER_INCLUDE,
    });
    if (mustRevoke) {
      await this.auditVerification({
        clientId: (app as { clientId: string }).clientId,
        action: "re_review",
        justification: "allowedOrigins changed — re-review required before waiver resumes",
        actorPid: ownerPid,
      });
      await this.security?.log(ownerPid, "app.verification.revoked", {
        clientId: (app as { clientId: string }).clientId, reason: "origins_changed",
      }).catch(() => null);
    }
    return withLoginMethods(updated);
  }

  /** Active app by client_id (null when unknown/disabled) — used by the SSO checks. */
  async findActive(clientId: string) {
    const app = await this.prisma.pidApp.findUnique({ where: { clientId }, include: PROVIDER_INCLUDE });
    if (!app || !app.isActive) return null;
    // ANT-804 D3 edge 6: lazy expiry — an overdue grant flips to unverified
    // on read (no cron), so display labels and SSO checks never show a dead
    // grant as verified. Fee quotes enforce the same via isVerificationActive.
    if (app.isVerified && app.verificationExpiresAt && new Date(app.verificationExpiresAt).getTime() <= Date.now()) {
      const cleared = await this.prisma.pidApp.update({
        where: { clientId },
        data: { isVerified: false },
      }).catch(() => null);
      await this.auditVerification({
        clientId, action: "expired", justification: "grant expired — waiver off", actorPid: "system",
      });
      await this.security?.log(app.ownerPid, "app.verification.revoked", { clientId, reason: "expired" }).catch(() => null);
      return withLoginMethods({ ...app, ...(cleared ?? {}), isVerified: false });
    }
    return withLoginMethods(app);
  }

  /**
   * Active app by client_id, but only when `origin` is one of its registered
   * origins. A client_id typed into a popup URL proves nothing on its own, so
   * the consent screen's name/logo are shown only for an origin the app owns.
   */
  async findActiveForOrigin(clientId: string, origin: string) {
    const app = await this.findActive(clientId);
    if (!app) return null;
    let normalized: string;
    try {
      normalized = normalizeOrigin(origin);
    } catch {
      return null;
    }
    return (app.allowedOrigins as string[]).includes(normalized) ? app : null;
  }

  /** SHA-256 hex of a plaintext secret (what's stored — never the secret itself). */
  static hashSecret(secret: string, pepper = ""): string {
    const input = pepper ? `${pepper}:${secret}` : secret;
    return createHash("sha256").update(input, "utf8").digest("hex");
  }

  /** Constant-time comparison against a stored hash (both always 32 bytes). */
  static secretMatches(secret: string, hashHex: string, pepper = ""): boolean {
    try {
      const a = Buffer.from(PidAppsService.hashSecret(secret, pepper), "hex");
      const b = Buffer.from(hashHex, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Full confidential-client check: hash match (peppered, legacy fallback)
   * AND not past `clientSecretExpiresAt`. No secret set = public client,
   * always valid. Callers must map false to a uniform error (no oracle).
   * The previous hash (ANT-283 rotation grace) also verifies while its own
   * overlap deadline is in the future.
   */
  clientSecretValid(
    app: {
      clientSecretHash: string | null;
      clientSecretExpiresAt?: Date | null;
      prevClientSecretHash?: string | null;
      prevClientSecretExpiresAt?: Date | null;
    },
    secret: string,
  ): boolean {
    if (!app.clientSecretHash) return true;
    if (app.clientSecretExpiresAt && app.clientSecretExpiresAt <= new Date()) return false;
    const pepper = this.pepper();
    if (pepper && PidAppsService.secretMatches(secret, app.clientSecretHash, pepper)) return true;
    if (PidAppsService.secretMatches(secret, app.clientSecretHash)) return true;
    // Previous-secret grace: same peppered + legacy fallback, gated by its
    // own short deadline. An expired or missing previous hash never verifies.
    if (
      app.prevClientSecretHash &&
      app.prevClientSecretExpiresAt &&
      app.prevClientSecretExpiresAt > new Date()
    ) {
      if (pepper && PidAppsService.secretMatches(secret, app.prevClientSecretHash, pepper)) return true;
      if (PidAppsService.secretMatches(secret, app.prevClientSecretHash)) return true;
    }
    return false;
  }

  /** Ownership strictly from the token — never a client-supplied identity. */
  private async ownedApp(ownerPid: string, id: string) {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerPid }, include: PROVIDER_INCLUDE });
    if (!app) throw new NotFoundException("App not found");
    return withLoginMethods(app);
  }

  /**
   * Generate (or rotate) an app's backend secret. Returns the plaintext ONCE — it is
   * never stored or shown again. Show `prefix` afterwards for identification.
   * The secret expires after APP_CLIENT_SECRET_MAX_AGE (365d); exchanges past
   * expiry fail closed until the owner rotates (uniform error, no oracle).
   * Rotation keeps a grace window (ANT-283): the replaced hash moves to
   * `prevClientSecretHash` and keeps verifying for APP_CLIENT_SECRET_GRACE
   * (24h), so concurrent deploys pick up the new secret without instant 401s.
   * A second rotation supersedes the previous grace window.
   */
  async rotateSecret(
    ownerPid: string,
    id: string,
  ): Promise<{ secret: string; prefix: string; graceExpiresAt: Date | null }> {
    const app = await this.ownedApp(ownerPid, id);
    const secret = `pidsk_${randomBytes(24).toString("hex")}`;
    const prefix = secret.slice(0, 12);
    const hadPrevious = !!(app as { clientSecretHash?: string | null }).clientSecretHash;
    const graceExpiresAt = hadPrevious
      ? new Date(Date.now() + parseTtlMs(APP_CLIENT_SECRET_GRACE, "APP_CLIENT_SECRET_GRACE"))
      : null;
    await this.prisma.pidApp.update({
      where: { id },
      data: {
        prevClientSecretHash: (app as { clientSecretHash?: string | null }).clientSecretHash ?? null,
        prevClientSecretExpiresAt: graceExpiresAt,
        clientSecretHash: PidAppsService.hashSecret(secret, this.pepper()),
        clientSecretPrefix: prefix,
        clientSecretCreatedAt: new Date(),
        clientSecretExpiresAt: new Date(Date.now() + parseTtlMs(APP_CLIENT_SECRET_MAX_AGE, "APP_CLIENT_SECRET_MAX_AGE")),
      },
    });
    return { secret, prefix, graceExpiresAt };
  }

  /**
   * Set (or clear) the app's ledger-callback endpoint. Setting generates a new
   * signing secret returned ONCE; PeridotID signs every callback body with it
   * (`X-Pid-Signature: sha256=<hex>`). https required (localhost excepted for
   * dev). Clearing removes both URL and secret.
   *
   * Storage (ANT-286a): the secret is envelope-encrypted with AES-256-GCM
   * (`PID_SECRETS_ENC_KEY`) into an `enc:v1:` same-column envelope before
   * storage. `encryptSecret` throws when the key is missing/malformed, so a
   * write without a usable key fails closed — plaintext is never persisted.
   * Dispatch decrypts server-side (fiat-ledger.service); legacy plaintext
   * rows keep reading until rotated. The setter still returns the plaintext
   * ONCE; it is never returned again (PUBLIC_OMIT strips it everywhere else).
   */
  async setWebhook(ownerPid: string, id: string, url: string | null): Promise<{ url: string | null; secret: string | null }> {
    await this.ownedApp(ownerPid, id);
    if (url === null) {
      await this.prisma.pidApp.update({ where: { id }, data: { webhookUrl: null, webhookSecret: null } });
      return { url: null, secret: null };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException("url must be an http(s) URL");
    }
    const localhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhost)) {
      throw new BadRequestException("webhook URL must use https (http allowed only for localhost)");
    }
    const secret = `pidwh_${randomBytes(24).toString("hex")}`;
    const target = parsed.toString();
    // ANT-286a: fail closed without a usable data key — never store plaintext.
    const encKey = this.config?.get<string>("PID_SECRETS_ENC_KEY") ?? process.env.PID_SECRETS_ENC_KEY;
    const stored = encryptSecret(secret, encKey);
    await this.prisma.pidApp.update({ where: { id }, data: { webhookUrl: target, webhookSecret: stored } });
    return { url: target, secret };
  }

  /** Supported per-app fee operations. */
  static readonly FEE_OPERATIONS = ["topup", "transaction", "withdraw"] as const;

  /** Per-app fee schedule (all operations, defaults when unset). */
  async listFees(ownerPid: string, id: string) {
    await this.ownedApp(ownerPid, id);
    const rows = await this.prisma.pidAppFee.findMany({ where: { appId: id } });
    const byOp = new Map(rows.map((r) => [r.operation, r]));
    return PidAppsService.FEE_OPERATIONS.map((op) => {
      const r = byOp.get(op);
      return {
        operation: op,
        percentBps: r?.percentBps ?? 0,
        minIdr: (r?.minIdr ?? 0n).toString(),
        maxIdr: (r?.maxIdr ?? 0n).toString(),
        enabled: r?.enabled ?? false,
      };
    });
  }

  /** Upsert one operation's per-app fee. Stacks on the global PeridotID fee
   *  and credits the app's own account. */
  async setFee(
    ownerPid: string,
    id: string,
    operation: string,
    input: { percentBps: number; minIdr: string; maxIdr: string; enabled: boolean },
  ) {
    await this.ownedApp(ownerPid, id);
    if (!(PidAppsService.FEE_OPERATIONS as readonly string[]).includes(operation)) {
      throw new BadRequestException(`operation must be one of ${PidAppsService.FEE_OPERATIONS.join(", ")}`);
    }
    const minIdr = BigInt(input.minIdr);
    const maxIdr = BigInt(input.maxIdr);
    if (minIdr > 0n && maxIdr > 0n && minIdr > maxIdr) {
      throw new BadRequestException("minIdr cannot exceed maxIdr");
    }
    const row = await this.prisma.pidAppFee.upsert({
      where: { appId_operation: { appId: id, operation } },
      create: { appId: id, operation, percentBps: input.percentBps, minIdr, maxIdr, enabled: input.enabled },
      update: { percentBps: input.percentBps, minIdr, maxIdr, enabled: input.enabled },
    });
    return {
      operation: row.operation,
      percentBps: row.percentBps,
      minIdr: row.minIdr.toString(),
      maxIdr: row.maxIdr.toString(),
      enabled: row.enabled,
    };
  }
}
