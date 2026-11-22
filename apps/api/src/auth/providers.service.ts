import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { encryptSecret } from "../common/secret-crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { adapterFor, apiUrlFrom, oauthRedirectUri } from "./provider-adapters";

const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const FAMILY_CODE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
// https URL or same-origin path, raster image extension only (never SVG).
const IMAGE_URL = /^(https:\/\/[^\s?#]+|\/(?!\/)[^\s?#]*)\.(png|jpe?g|webp|gif|avif)(\?[^\s]*)?$/i;

const CHAIN_SELECT = {
  chainPolicies: {
    select: {
      namespace: true,
      mode: true,
      selections: {
        select: { chain: { select: { id: true, namespace: true, reference: true, name: true, isActive: true } } },
      },
    },
  },
} as const;

const OAUTH_META = {
  select: { clientId: true, scopes: true, redirectUri: true, secretUpdatedAt: true },
} as const;

type ProviderRow = {
  code: string;
  name: string;
  imageUrl: string | null;
  category: string;
  protocol: string;
  isAvailable: boolean;
  chainPolicies?: unknown[];
  platformOauthConfig?: { clientId: string; scopes: string[]; redirectUri: string; secretUpdatedAt: Date } | null;
};

export interface ProviderLoginsFilter {
  appId?: string;
  pid?: string;
  providerCode?: string;
  evidence?: "server" | "client_selected" | "unknown";
  from?: Date;
  to?: Date;
}

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
    private readonly config: ConfigService,
  ) {}

  /** Fail closed when a provider is absent or switched off globally. */
  async assertUsable(code: string): Promise<void> {
    const provider = await this.prisma.loginProvider.findUnique({
      where: { code },
      select: { isAvailable: true },
    });
    if (!provider || !provider.isAvailable) throw new BadRequestException("This sign-in method is not available");
  }

  /** Public catalogue: ready providers only are usable by clients. Never secrets. */
  async list() {
    const rows = await this.prisma.loginProvider.findMany({
      orderBy: { code: "asc" },
      select: {
        code: true, name: true, imageUrl: true, category: true, protocol: true, isAvailable: true,
        ...CHAIN_SELECT,
      },
    });
    return rows.map(row => this.decorate(row));
  }

  /** Admin catalogue: readiness, adapter and OAuth client metadata (no secret). */
  async adminList() {
    const rows = await this.prisma.loginProvider.findMany({
      orderBy: { code: "asc" },
      select: {
        code: true, name: true, imageUrl: true, category: true, protocol: true, isAvailable: true,
        ...CHAIN_SELECT,
        platformOauthConfig: OAUTH_META,
      },
    });
    return rows.map(row => this.decorate(row));
  }

  async detail(code: string) {
    const row = await this.prisma.loginProvider.findUnique({
      where: { code },
      select: {
        code: true, name: true, imageUrl: true, category: true, protocol: true, isAvailable: true,
        ...CHAIN_SELECT,
        platformOauthConfig: OAUTH_META,
      },
    });
    if (!row) throw new NotFoundException("Provider not found");
    return this.decorate(row);
  }

  /**
   * Add a catalogue entry. It starts unavailable: an adapter must exist and
   * OAuth credentials must be complete before it can be switched on.
   */
  async create(
    actorPid: string,
    data: { code: string; name: string; category: "web2" | "web3"; protocol: string; imageUrl?: string | null },
  ) {
    if (!PROVIDER_CODE.test(data.code)) throw new BadRequestException("Invalid provider code");
    this.assertClassification(data.category, data.protocol);
    const name = data.name.trim();
    if (!name || name.length > 80) throw new BadRequestException("Invalid provider name");
    if (data.imageUrl && !IMAGE_URL.test(data.imageUrl)) throw new BadRequestException("Invalid image URL");
    const adapter = adapterFor(data.code);
    if (adapter && !adapter.protocols.includes(data.protocol as never)) {
      throw new BadRequestException("Provider protocol does not match its adapter");
    }
    try {
      await this.prisma.$transaction(async tx => {
        await tx.loginProvider.create({
          data: {
            code: data.code, name, category: data.category, protocol: data.protocol as never,
            imageUrl: data.imageUrl ?? null, isAvailable: false,
          },
        });
        // OAuth credentials are keyed by provider code in identity_credentials.
        if (data.protocol === "oauth") {
          await tx.credentialDomain.create({ data: { code: data.code, providerCode: data.code } });
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException("Provider code already exists");
      }
      throw err;
    }
    await this.audit(actorPid, "provider.created", { providerCode: data.code, protocol: data.protocol, category: data.category });
    return this.detail(data.code);
  }

  /** Edit display metadata and availability. Protocol/category are immutable. */
  async update(actorPid: string, code: string, data: { name?: string; imageUrl?: string | null; isAvailable?: boolean }) {
    const provider = await this.prisma.loginProvider.findUnique({
      where: { code },
      select: { code: true, name: true, protocol: true, isAvailable: true, platformOauthConfig: OAUTH_META },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    if (data.name !== undefined && (!data.name.trim() || data.name.trim().length > 80)) {
      throw new BadRequestException("Invalid provider name");
    }
    if (data.imageUrl && !IMAGE_URL.test(data.imageUrl)) throw new BadRequestException("Invalid image URL");
    if (data.isAvailable === true) this.assertCanEnable(provider);
    const changed = [
      ...(data.name !== undefined ? ["name"] : []),
      ...(data.imageUrl !== undefined ? ["imageUrl"] : []),
      ...(data.isAvailable !== undefined ? ["isAvailable"] : []),
    ];
    await this.prisma.loginProvider.update({
      where: { code },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl || null } : {}),
        ...(data.isAvailable !== undefined ? { isAvailable: data.isAvailable } : {}),
      },
    });
    await this.audit(actorPid, "provider.updated", {
      providerCode: code, fields: changed,
      ...(data.isAvailable !== undefined ? { isAvailable: data.isAvailable } : {}),
    });
    return this.detail(code);
  }

  /** OAuth client metadata for the admin form. Secret is never returned. */
  async oauthConfig(code: string) {
    const provider = await this.prisma.loginProvider.findUnique({
      where: { code },
      select: { code: true, protocol: true, platformOauthConfig: OAUTH_META },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    if (provider.protocol !== "oauth") throw new BadRequestException("Provider is not OAuth");
    const adapter = adapterFor(code);
    const row = provider.platformOauthConfig;
    return {
      providerCode: code,
      adapter: adapter?.adapter ?? null,
      isSupported: Boolean(adapter?.implemented),
      redirectUri: row?.redirectUri ?? oauthRedirectUri(apiUrlFrom((key, def) => this.config.get(key, def)), code),
      clientId: row?.clientId ?? null,
      scopes: row?.scopes ?? adapter?.oauth?.scopes ?? [],
      secretUpdatedAt: row?.secretUpdatedAt?.toISOString() ?? null,
      hasSecret: Boolean(row),
      configSource: row ? "database" : this.envConfigured(code) ? "environment" : "none",
    };
  }

  /** Write-only client secret (encrypted envelope). Rotating never echoes it. */
  async setOauthConfig(
    actorPid: string,
    code: string,
    data: { clientId: string; clientSecret?: string; scopes?: string[] },
  ) {
    const provider = await this.prisma.loginProvider.findUnique({
      where: { code },
      select: { code: true, protocol: true, platformOauthConfig: { select: { providerCode: true } } },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    if (provider.protocol !== "oauth") throw new BadRequestException("Provider is not OAuth");
    const adapter = adapterFor(code);
    if (!adapter?.implemented || !adapter.oauth) {
      throw new BadRequestException("No OAuth adapter is implemented for this provider yet");
    }
    const clientId = data.clientId?.trim();
    if (!clientId || clientId.length > 200) throw new BadRequestException("Invalid client ID");
    if (!provider.platformOauthConfig && !data.clientSecret) {
      throw new BadRequestException("Client secret is required for a new configuration");
    }
    const scopes = [...new Set((data.scopes ?? adapter.oauth.scopes).map(s => s.trim()).filter(Boolean))];
    if (scopes.length > 20 || scopes.some(s => s.length > 100)) throw new BadRequestException("Invalid scopes");
    const redirectUri = oauthRedirectUri(apiUrlFrom((key, def) => this.config.get(key, def)), code);
    const secretEnc = data.clientSecret
      ? encryptSecret(data.clientSecret, this.config.get<string>("PID_SECRETS_ENC_KEY"))
      : undefined;
    await this.prisma.platformOAuthConfig.upsert({
      where: { providerCode: code },
      create: { providerCode: code, clientId, scopes, redirectUri, clientSecretEnc: secretEnc! },
      update: { clientId, scopes, redirectUri, ...(secretEnc ? { clientSecretEnc: secretEnc } : {}) },
    });
    await this.audit(actorPid, "provider.oauth.configured", {
      providerCode: code, clientId, scopes, secretRotated: Boolean(data.clientSecret),
    });
    return this.oauthConfig(code);
  }

  async chainFamilies() {
    const rows = await this.prisma.chainFamily.findMany({
      orderBy: { code: "asc" },
      select: {
        code: true,
        chains: { orderBy: [{ namespace: "asc" }, { reference: "asc" }],
          select: { id: true, namespace: true, reference: true, name: true, isActive: true } },
      },
    });
    return rows;
  }

  async createFamily(actorPid: string, code: string) {
    if (!FAMILY_CODE.test(code)) throw new BadRequestException("Invalid chain family code");
    try {
      const family = await this.prisma.chainFamily.create({ data: { code } });
      await this.audit(actorPid, "chain-family.created", { family: code });
      return { ...family, chains: [] };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException("Chain family already exists");
      }
      throw err;
    }
  }

  async chains(actorPid: string, code: string, namespace: string, mode: "all" | "selected", chainIds: string[]) {
    const ids = [...new Set(chainIds)];
    if (mode === "all" && ids.length) throw new BadRequestException("All mode cannot contain individual chains");
    const result = await this.prisma.$transaction(async tx => {
      const provider = await tx.loginProvider.findUnique({ where: { code } });
      if (!provider || provider.protocol !== "wallet_signature") throw new BadRequestException("Wallet provider required");
      if (!await tx.chainFamily.findUnique({ where: { code: namespace } })) throw new BadRequestException("Unknown chain family");
      if (await tx.chain.count({ where: { id: { in: ids }, namespace } }) !== ids.length) throw new BadRequestException("Every chain must belong to the chosen family");
      // Serialize updates to this provider: delete/recreate is one atomic replacement.
      await tx.$executeRaw`SELECT 1 FROM providers WHERE code=${code} FOR UPDATE`;
      const prior = await tx.providerChainPolicy.findUnique({ where: { providerCode_namespace: { providerCode: code, namespace } } });
      if (prior) await tx.providerChainSelection.deleteMany({ where: { policyId: prior.id } });
      return tx.providerChainPolicy.upsert({
        where: { providerCode_namespace: { providerCode: code, namespace } },
        create: { providerCode: code, namespace, mode, selections: { create: ids.map(chainId => ({ chainId })) } },
        update: { mode, selections: { create: ids.map(chainId => ({ chainId })) } },
        include: { selections: true },
      });
    });
    await this.audit(actorPid, "provider.chains.updated", { providerCode: code, namespace, mode, chainIds: ids });
    return result;
  }

  async logins(appId: string | undefined, page: number, filter: ProviderLoginsFilter = {}) {
    const where = {
      ...(appId ? { appId } : {}),
      ...(filter.appId ? { appId: filter.appId } : {}),
      ...(filter.pid ? { pid: filter.pid } : {}),
      ...(filter.providerCode ? { providerCode: filter.providerCode } : {}),
      ...(filter.evidence ? { providerEvidence: filter.evidence } : {}),
      ...(filter.from || filter.to ? {
        occurredAt: {
          ...(filter.from ? { gte: filter.from } : {}),
          ...(filter.to ? { lte: filter.to } : {}),
        },
      } : {}),
    };
    const [events, total] = await this.prisma.$transaction([
      this.prisma.loginEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * 25, take: 25,
        select: { id: true, appId: true, pid: true, occurredAt: true, providerEvidence: true,
          app: { select: { id: true, name: true, clientId: true } },
          provider: { select: { code: true, name: true, imageUrl: true, category: true } } } }),
      this.prisma.loginEvent.count({ where }),
    ]);
    return { events, total, page, pageSize: 25 };
  }

  private decorate<T extends ProviderRow>(row: T) {
    const adapter = adapterFor(row.code);
    const isSupported = Boolean(adapter?.implemented && adapter.protocols.includes(row.protocol as never));
    const configSource = row.protocol === "oauth"
      ? row.platformOauthConfig ? "database" : this.envConfigured(row.code) ? "environment" : "none"
      : "adapter";
    const isConfigured = row.protocol === "oauth" ? isSupported && configSource !== "none" : isSupported;
    return {
      ...row,
      adapter: adapter?.adapter ?? null,
      isSupported,
      isConfigured,
      configSource,
      oauth: row.platformOauthConfig
        ? { clientId: row.platformOauthConfig.clientId, scopes: row.platformOauthConfig.scopes,
            redirectUri: row.platformOauthConfig.redirectUri,
            secretUpdatedAt: row.platformOauthConfig.secretUpdatedAt.toISOString(), hasSecret: true }
        : null,
    };
  }

  /** Only the Google runtime currently reads platform env credentials. */
  private envConfigured(code: string): boolean {
    if (code !== "google") return false;
    return Boolean(this.config.get("GOOGLE_CLIENT_ID") && this.config.get("GOOGLE_CLIENT_SECRET"));
  }

  private assertCanEnable(provider: { code: string; protocol: string; platformOauthConfig: unknown }) {
    const adapter = adapterFor(provider.code);
    if (!adapter?.implemented || !adapter.protocols.includes(provider.protocol as never)) {
      throw new BadRequestException("No runtime adapter is implemented for this provider");
    }
    if (provider.protocol === "oauth" && !provider.platformOauthConfig && !this.envConfigured(provider.code)) {
      throw new BadRequestException("OAuth configuration is incomplete");
    }
  }

  private assertClassification(category: string, protocol: string) {
    if (category === "web3" && protocol !== "wallet_signature") throw new BadRequestException("Web3 providers use wallet signatures");
    if (category === "web2" && protocol === "wallet_signature") throw new BadRequestException("Wallet providers are Web3");
  }

  private audit(actorPid: string, eventType: string, metadata: Record<string, unknown>) {
    return this.security.log(actorPid, eventType, metadata).catch(() => null);
  }
}
