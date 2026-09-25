// Self-serve OAuth client registry ("Sign in with PeridotID"). Any logged-in identity
// can register an app and get a public client_id; PeridotID only returns pid_codes to
// the app's registered redirect URIs. CORS origins are derived from those URIs.

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Normalize a developer-supplied origin: strip trailing slashes, reject anything
 * that isn't a bare http(s) origin (no path, query, or fragment).
 */
export function normalizeOrigin(value: string): string {
  // Hostnames are case-insensitive; lowercase the whole bare origin (no path allowed).
  const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("origin_not_http");
  if (parsed.origin !== trimmed) throw new Error("origin_not_bare");
  return parsed.origin;
}

@Injectable()
export class PidAppsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Never expose secret material in API responses (hash or plaintext). */
  private static readonly PUBLIC_OMIT = { webhookSecret: true, clientSecretHash: true } as const;

  async create(ownerPid: string, name: string, allowedOrigins: string[] = []) {
    const clientId = `pidapp_${randomBytes(16).toString("hex")}`;
    return this.prisma.pidApp.create({
      data: { clientId, ownerPid, name, allowedOrigins: [...new Set(allowedOrigins.map(normalizeOrigin))] },
      omit: PidAppsService.PUBLIC_OMIT,
    });
  }

  async list(ownerPid: string) {
    return this.prisma.pidApp.findMany({ where: { ownerPid }, orderBy: { createdAt: "desc" }, omit: PidAppsService.PUBLIC_OMIT });
  }

  /** One owned app (404 for anyone else — never leak another owner's app). */
  async get(ownerPid: string, id: string) {
    const app = await this.ownedApp(ownerPid, id);
    const { webhookSecret: _s, clientSecretHash: _h, ...safe } = app;
    return safe;
  }

  async update(ownerPid: string, id: string, patch: { name?: string; allowedOrigins?: string[]; isActive?: boolean }) {
    await this.ownedApp(ownerPid, id);
    return this.prisma.pidApp.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.allowedOrigins !== undefined
          ? { allowedOrigins: [...new Set(patch.allowedOrigins.map(normalizeOrigin))] }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      omit: PidAppsService.PUBLIC_OMIT,
    });
  }

  /** Active app by client_id (null when unknown/disabled) — used by the SSO checks. */
  async findActive(clientId: string) {
    const app = await this.prisma.pidApp.findUnique({ where: { clientId } });
    return app && app.isActive ? app : null;
  }

  /** SHA-256 hex of a plaintext secret (what's stored — never the secret itself). */
  static hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  /** Constant-time comparison against a stored hash (both always 32 bytes). */
  static secretMatches(secret: string, hashHex: string): boolean {
    try {
      const a = Buffer.from(PidAppsService.hashSecret(secret), "hex");
      const b = Buffer.from(hashHex, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Ownership strictly from the token — never a client-supplied identity. */
  private async ownedApp(ownerPid: string, id: string) {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerPid } });
    if (!app) throw new NotFoundException("App not found");
    return app;
  }

  /**
   * Generate (or rotate) an app's backend secret. Returns the plaintext ONCE — it is
   * never stored or shown again. Show `prefix` afterwards for identification.
   */
  async rotateSecret(ownerPid: string, id: string): Promise<{ secret: string; prefix: string }> {
    await this.ownedApp(ownerPid, id);
    const secret = `pidsk_${randomBytes(24).toString("hex")}`;
    const prefix = secret.slice(0, 12);
    await this.prisma.pidApp.update({
      where: { id },
      data: {
        clientSecretHash: PidAppsService.hashSecret(secret),
        clientSecretPrefix: prefix,
        clientSecretCreatedAt: new Date(),
      },
    });
    return { secret, prefix };
  }

  /**
   * Set (or clear) the app's ledger-callback endpoint. Setting generates a new
   * signing secret returned ONCE; PeridotID signs every callback body with it
   * (`X-Pid-Signature: sha256=<hex>`). https required (localhost excepted for
   * dev). Clearing removes both URL and secret.
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
    await this.prisma.pidApp.update({ where: { id }, data: { webhookUrl: target, webhookSecret: secret } });
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
