// Self-serve OAuth client registry ("Sign in with PeridotID"). Any logged-in identity
// can register an app and get a public client_id; PeridotID only returns pid_codes to
// the app's registered redirect URIs. CORS origins are derived from those URIs.

import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export function originsOf(redirectUris: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of redirectUris) {
    try {
      origins.add(new URL(uri).origin);
    } catch {
      // validated upstream; skip defensively
    }
  }
  return [...origins];
}

@Injectable()
export class PidAppsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, name: string, redirectUris: string[]) {
    const clientId = `pidapp_${randomBytes(16).toString("hex")}`;
    return this.prisma.pidApp.create({
      data: { clientId, ownerId, name, redirectUris, allowedOrigins: originsOf(redirectUris) },
    });
  }

  async list(ownerId: string) {
    return this.prisma.pidApp.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } });
  }

  async update(ownerId: string, id: string, patch: { name?: string; redirectUris?: string[]; isActive?: boolean }) {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerId } });
    if (!app) throw new NotFoundException("App not found");
    return this.prisma.pidApp.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.redirectUris !== undefined
          ? { redirectUris: patch.redirectUris, allowedOrigins: originsOf(patch.redirectUris) }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
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

  /**
   * Generate (or rotate) an app's backend secret. Returns the plaintext ONCE — it is
   * never stored or shown again. Show `prefix` afterwards for identification.
   */
  async rotateSecret(ownerId: string, id: string): Promise<{ secret: string; prefix: string }> {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerId } });
    if (!app) throw new NotFoundException("App not found");
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
}
