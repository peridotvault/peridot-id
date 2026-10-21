// Admin chain-registry management. Every write invalidates the registry cache
// and emits a security event (who changed what). Deactivation (not delete)
// keeps history and lets the wallet hide a chain instantly.
import { ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { encryptSecret } from "../common/secret-crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CreateChainDto, UpdateChainDto, UpsertContractDto } from "./admin.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: ChainRegistryService,
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
  async listAllApps(q?: string, take?: number, skip?: number) {
    const needle = q?.trim() || undefined;
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
}
