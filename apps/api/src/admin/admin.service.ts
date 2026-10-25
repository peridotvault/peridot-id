// Admin chain-registry management. Every write invalidates the registry cache
// and emits a security event (who changed what). Deactivation (not delete)
// keeps history and lets the wallet hide a chain instantly.
import { ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { TokenRegistryService } from "../chain/token-registry.service";
import { proxyLogoUrl, tokenLogoKey } from "../common/wasabi-storage";
import { WasabiStorageService } from "../common/wasabi-storage";
import { encryptSecret } from "../common/secret-crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CreateChainDto, CreateTokenDto, PreviewTokenDto, UpdateChainDto, UpdateTokenDeploymentDto, UpdateTokenDto, UpsertContractDto } from "./admin.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: ChainRegistryService,
    private readonly tokenRegistry: TokenRegistryService,
    private readonly wasabi: WasabiStorageService,
    private readonly security: SecurityEventService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  listChains() {
    return this.prisma.chain.findMany({
      include: { contracts: { orderBy: { type: "asc" } } },
      orderBy: [{ namespace: "asc" }, { reference: "asc" }],
    });
  }

  async createChain(pid: string, dto: CreateChainDto) {
    const existing = await this.prisma.chain.findUnique({
      where: { namespace_reference: { namespace: dto.namespace, reference: dto.reference } },
    });
    if (existing) throw new ConflictException("Chain already registered");
    const chain = await this.prisma.chain.create({
      data: {
        namespace: dto.namespace,
        reference: dto.reference,
        name: dto.name,
        nativeSymbol: dto.nativeSymbol,
        decimals: dto.decimals ?? (dto.namespace === "solana" ? 9 : 18),
        rpcUrls: dto.rpcUrls ?? [],
        explorerUrl: dto.explorerUrl,
        logoUrl: dto.logoUrl,
        isTestnet: dto.isTestnet ?? true,
      },
      include: { contracts: true },
    });
    this.chains.invalidate();
    await this.security.log(pid, "admin.chain.created", { chainId: chain.id, reference: dto.reference });
    return chain;
  }

  async updateChain(pid: string, id: string, dto: UpdateChainDto) {
    const chain = await this.prisma.chain.findUnique({ where: { id } });
    if (!chain) throw new NotFoundException("Chain not found");
    const updated = await this.prisma.chain.update({ where: { id }, data: { ...dto }, include: { contracts: true } });
    this.chains.invalidate();
    await this.security.log(pid, "admin.chain.updated", { chainId: id });
    return updated;
  }

  /** Set the current address for one contract type on a chain (upsert by type). */
  async upsertContract(pid: string, chainId: string, dto: UpsertContractDto) {
    const chain = await this.prisma.chain.findUnique({ where: { id: chainId } });
    if (!chain) throw new NotFoundException("Chain not found");
    if (chain.namespace === "solana" && (dto.type === "factory" || dto.type === "account_implementation")) {
      throw new ConflictException("EVM contract types do not apply to Solana chains");
    }
    const contract = await this.prisma.chainContract.upsert({
      where: { chainId_type: { chainId, type: dto.type } },
      update: {
        address: dto.address,
        versionLabel: dto.versionLabel,
        deployTxHash: dto.deployTxHash,
        isActive: dto.isActive ?? true,
      },
      create: {
        chainId,
        type: dto.type,
        address: dto.address,
        versionLabel: dto.versionLabel,
        deployTxHash: dto.deployTxHash,
        isActive: dto.isActive ?? true,
      },
    });
    this.chains.invalidate();
    await this.security.log(pid, "admin.contract.upserted", { chainId, type: dto.type });
    return contract;
  }

  /**
   * Set the EVM auto-deploy relayer key for a chain (write-only — the secret
   * is never returned; see the presence flag). EVM chains only. ANT-286a:
   * the secret is envelope-encrypted (`enc:v1:`) before storage; a missing or
   * malformed `PID_SECRETS_ENC_KEY` fails closed (never stores plaintext).
   */
  async setEvmRelayer(pid: string, chainId: string, secret: string) {
    const chain = await this.prisma.chain.findUnique({ where: { id: chainId } });
    if (!chain) throw new NotFoundException("Chain not found");
    if (chain.namespace !== "eip155") throw new ConflictException("EVM relayer keys apply to eip155 chains only");
    const encKey = this.config?.get<string>("PID_SECRETS_ENC_KEY") ?? process.env.PID_SECRETS_ENC_KEY;
    const stored = encryptSecret(secret, encKey);
    const row = await this.prisma.evmRelayerKey.upsert({
      where: { chainId },
      update: { secret: stored },
      create: { chainId, secret: stored },
    });
    await this.security.log(pid, "admin.evm_relayer.set", { chainId });
    return { chainId, hasSecret: true, updatedAt: row.updatedAt };
  }

  /** Remove the EVM auto-deploy relayer key (auto-deploy falls back to the operator flow). */
  async deleteEvmRelayer(pid: string, chainId: string) {
    const chain = await this.prisma.chain.findUnique({ where: { id: chainId } });
    if (!chain) throw new NotFoundException("Chain not found");
    await this.prisma.evmRelayerKey.deleteMany({ where: { chainId } });
    await this.security.log(pid, "admin.evm_relayer.deleted", { chainId });
    return { ok: true as const };
  }

  /**
   * Verify (or unverify) a partner app: verified apps skip the global
   * PeridotID fiat fee. Admin-only — app owners can never set this themselves.
   */
  async setAppVerified(pid: string, id: string, verified: boolean) {
    const app = await this.prisma.pidApp.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("App not found");
    const updated = await this.prisma.pidApp.update({ where: { id }, data: { isVerified: verified } });
    await this.security.log(pid, verified ? "admin.app.verified" : "admin.app.unverified", {
      appId: id,
      clientId: app.clientId,
    });
    const { webhookSecret: _s, clientSecretHash: _h, prevClientSecretHash: _p, ...safe } = updated as typeof updated & { prevClientSecretHash?: unknown };
    return safe;
  }
  /** Admin lookup of any app by public client_id (secrets omitted). */
  async findAppByClientId(clientId: string) {
    const app = await this.prisma.pidApp.findUnique({ where: { clientId } });
    if (!app) throw new NotFoundException("App not found");
    const { webhookSecret: _s, clientSecretHash: _h, prevClientSecretHash: _p, ...safe } = app as typeof app & { prevClientSecretHash?: unknown };
    return safe;
  }

  /** Every registered app, newest first (secrets omitted). Admin-only.
   *  Optional substring filter over name (case-insensitive) or clientId.
   *  ANT-344 L5: bounded paging — `take` defaults to 500 and is capped, so
   *  the directory can never issue an unbounded table scan. */
  async listAllApps(q?: string, take?: number, skip?: number) {    const needle = q?.trim() || undefined;
    const limit = Math.min(Math.max(Math.floor(take ?? 500), 1), 500);
    const offset = Math.max(Math.floor(skip ?? 0), 0);
    const apps = await this.prisma.pidApp.findMany({
      ...(needle
        ? { where: { OR: [{ name: { contains: needle, mode: "insensitive" } }, { clientId: { contains: needle } }] } }
        : {}),
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset || undefined,
    });
    return apps.map((app) => {
      const { webhookSecret: _s, clientSecretHash: _h, prevClientSecretHash: _p, ...safe } = app as typeof app & { prevClientSecretHash?: unknown };
      return safe;
    });
  }

  // Curated token registry: Token holds GLOBAL metadata once; deployments
  // hang one token off many chains (chainId FK → chains.id). Single dashboard
  // Save creates token + deployments atomically. No delete — hiding is
  // `isVisible: false`, keeping history like chains.

  private apiBase(): string {
    return (this.config?.get<string>("API_URL") ?? process.env.API_URL ?? "").trim();
  }

  private withTokenLogo<T extends { logoKey: string | null }>(row: T): T & { logoUrl: string | null } {
    return { ...row, logoUrl: row.logoKey ? proxyLogoUrl(this.apiBase(), row.logoKey) : null };
  }

  listTokens() {
    return this.prisma.token
      .findMany({
        include: {
          deployments: { include: { chain: true }, orderBy: [{ chain: { namespace: "asc" } }, { chain: { reference: "asc" } }] },
        },
        orderBy: { symbol: "asc" },
      })
      .then((rows) => rows.map((r) => this.withTokenLogo(r)));
  }

  async createToken(pid: string, dto: CreateTokenDto) {
    const symbol = dto.symbol.toUpperCase();
    const existing = await this.prisma.token.findUnique({ where: { symbol } });
    if (existing) throw new ConflictException("Token symbol already registered");
    // Every deployment must point at a real chain row (dashboard picks from
    // the chains table) with a mint shaped for that chain's namespace.
    const chains = new Map<string, { namespace: string }>();
    for (const d of dto.deployments ?? []) {
      const chain = await this.prisma.chain.findUnique({ where: { id: d.chainId } });
      if (!chain) throw new NotFoundException(`Chain ${d.chainId} not found`);
      chains.set(d.chainId, chain);
    }
    const seenMint = new Set<string>();
    const deployments = (dto.deployments ?? []).map((d) => {
      const chain = chains.get(d.chainId)!;
      const mint = chain.namespace === "eip155" ? d.mint.toLowerCase() : d.mint;
      const dupKey = `${d.chainId}:${mint}`;
      if (seenMint.has(dupKey)) throw new ConflictException("Duplicate chain in deployments");
      seenMint.add(dupKey);
      return {
        chainId: d.chainId,
        mint,
        decimals: d.decimals,
        isVisible: d.isVisible ?? true,
        isPinned: d.isPinned ?? false,
        sortOrder: d.sortOrder ?? 0,
      };
    });
    const token = await this.prisma.token.create({
      data: { symbol, name: dto.name, deployments: { create: deployments } },
      include: { deployments: { include: { chain: true } } },
    });
    // Autofill logo: fetch the preview-suggested CoinGecko image (host-locked
    // by DTO validation — no open fetch) into Wasabi. Best-effort: a failed
    // fetch keeps the row, the admin uploads manually in the manager.
    if (dto.logoSourceUrl) {
      const logoKey = await this.fetchLogoToWasabi(symbol, dto.logoSourceUrl).catch(() => null);
      if (logoKey) {
        await this.prisma.token.update({ where: { id: token.id }, data: { logoKey } });
        token.logoKey = logoKey;
      }
    }
    this.tokenRegistry.invalidate();
    await this.security.log(pid, "admin.token.created", { tokenId: token.id, symbol });
    return this.withTokenLogo(token);
  }

  async updateToken(pid: string, id: string, dto: UpdateTokenDto) {
    const row = await this.prisma.token.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Token not found");
    let logoKey = row.logoKey;
    if (dto.symbol) {
      const nextSymbol = dto.symbol.toUpperCase();
      const clash = await this.prisma.token.findUnique({ where: { symbol: nextSymbol } });
      if (clash && clash.id !== id) throw new ConflictException("Token symbol already registered");
      // Symbol renames move the logo object so the tidy key never orphans.
      // Copy-then-delete inside storage; the DB row updates only after.
      if (nextSymbol !== row.symbol && row.logoKey) {
        const ext = row.logoKey.split(".").pop() ?? "png";
        const nextKey = tokenLogoKey(nextSymbol, ext);
        await this.wasabi.moveLogo(row.logoKey, nextKey);
        logoKey = nextKey;
      }
    }
    const updated = await this.prisma.token.update({
      where: { id },
      data: { symbol: dto.symbol?.toUpperCase(), name: dto.name, logoKey },
      include: { deployments: { include: { chain: true } } },
    });
    this.tokenRegistry.invalidate();
    await this.security.log(pid, "admin.token.updated", { tokenId: id });
    return this.withTokenLogo(updated);
  }

  async updateTokenDeployment(pid: string, deploymentId: string, dto: UpdateTokenDeploymentDto) {
    const row = await this.prisma.tokenDeployment.findUnique({ where: { id: deploymentId } });
    if (!row) throw new NotFoundException("Token deployment not found");
    const updated = await this.prisma.tokenDeployment.update({ where: { id: deploymentId }, data: { ...dto } });
    this.tokenRegistry.invalidate();
    await this.security.log(pid, "admin.token.deployment.updated", { deploymentId });
    return updated;
  }

  /** Attach a Wasabi logo to a token (one file per symbol). */
  async setTokenLogo(pid: string, id: string, file: { buffer: Buffer; mimetype: string; size: number; originalname: string }) {
    const row = await this.prisma.token.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Token not found");
    const logoKey = await this.wasabi.putTokenLogo(row.symbol, file);
    const updated = await this.prisma.token.update({ where: { id }, data: { logoKey } });
    this.tokenRegistry.invalidate();
    await this.security.log(pid, "admin.token.logo.updated", { tokenId: id, logoKey });
    return this.withTokenLogo(updated);
  }

  /**
   * Attach a Wasabi logo to a chain (one file per chain). Stored as the
   * proxy URL in the existing `logoUrl` column — no migration, manual URLs
   * keep working as fallback.
   */
  async setChainLogo(pid: string, chainId: string, file: { buffer: Buffer; mimetype: string; size: number; originalname: string }) {
    const chain = await this.prisma.chain.findUnique({ where: { id: chainId } });
    if (!chain) throw new NotFoundException("Chain not found");
    const logoKey = await this.wasabi.putChainLogo(chain.namespace, chain.reference, file);
    const logoUrl = proxyLogoUrl(this.apiBase(), logoKey);
    if (!logoUrl) throw new Error("API_URL is not configured");
    const updated = await this.prisma.chain.update({
      where: { id: chainId },
      data: { logoUrl },
      include: { contracts: true },
    });
    this.chains.invalidate();
    await this.security.log(pid, "admin.chain.logo.updated", { chainId, logoKey });
    return updated;
  }

  /** Fetch a preview-suggested logo into Wasabi (host already locked by DTO). */
  private async fetchLogoToWasabi(symbol: string, url: string): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "image/png,image/jpeg,image/webp" } });
      if (!res.ok) throw new Error(`logo fetch HTTP ${res.status}`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 512 * 1024) throw new Error("logo too large");
      return await this.wasabi.putTokenLogo(symbol, { buffer: buf, mimetype: type, size: buf.length, originalname: "logo" });
    } finally {
      clearTimeout(t);
    }
  }
}
