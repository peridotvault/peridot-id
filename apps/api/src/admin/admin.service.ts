// Admin chain-registry management. Every write invalidates the registry cache
// and emits a security event (who changed what). Deactivation (not delete)
// keeps history and lets the wallet hide a chain instantly.
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CreateChainDto, UpdateChainDto, UpsertContractDto } from "./admin.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: ChainRegistryService,
    private readonly security: SecurityEventService,
  ) {}

  listChains() {
    return this.prisma.chain.findMany({
      include: { contracts: { orderBy: { type: "asc" } } },
      orderBy: [{ namespace: "asc" }, { reference: "asc" }],
    });
  }

  async createChain(identityId: string, dto: CreateChainDto) {
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
    await this.security.log(identityId, "admin.chain.created", { chainId: chain.id, reference: dto.reference }, undefined);
    return chain;
  }

  async updateChain(identityId: string, id: string, dto: UpdateChainDto) {
    const chain = await this.prisma.chain.findUnique({ where: { id } });
    if (!chain) throw new NotFoundException("Chain not found");
    const updated = await this.prisma.chain.update({ where: { id }, data: { ...dto }, include: { contracts: true } });
    this.chains.invalidate();
    await this.security.log(identityId, "admin.chain.updated", { chainId: id }, undefined);
    return updated;
  }

  /** Set the current address for one contract type on a chain (upsert by type). */
  async upsertContract(identityId: string, chainId: string, dto: UpsertContractDto) {
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
    await this.security.log(identityId, "admin.contract.upserted", { chainId, type: dto.type }, undefined);
    return contract;
  }
}
