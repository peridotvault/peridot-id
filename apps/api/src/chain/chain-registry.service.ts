// Chain registry — admin-managed chains + typed contracts (DB first, code fallback).
//
// Reads never throw for missing tables/rows: an empty registry (fresh local dev,
// old unit-test doubles) falls back to the compiled-in chain list + env, so EVM
// stays off until a factory is configured exactly like before.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EVM_CHAINS } from "@peridotvault/pid-core/dist/evm";
import { PrismaService } from "../prisma/prisma.service";

export interface RegistryContract {
  type: string;
  address: string;
  versionLabel: string | null;
}

export interface RegistryChain {
  id: string;
  namespace: string;
  reference: string;
  name: string;
  nativeSymbol: string;
  decimals: number;
  rpcUrls: string[];
  explorerUrl: string | null;
  logoUrl: string | null;
  isTestnet: boolean;
  contracts: RegistryContract[];
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class ChainRegistryService {
  private cache: { at: number; chains: RegistryChain[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Drop the cache — called by every admin write. */
  invalidate(): void {
    this.cache = null;
  }

  /** All active chains with their active contracts. */
  async activeChains(): Promise<RegistryChain[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.chains;
    const chains = await this.readRegistry().catch(() => this.codeFallback());
    this.cache = { at: now, chains };
    return chains;
  }

  /** Active eip155 chains that have a factory + implementation (deployable). */
  async deployableEvmChains(): Promise<RegistryChain[]> {
    const chains = await this.activeChains();
    return chains.filter(
      (c) =>
        c.namespace === "eip155" &&
        c.contracts.some((k) => k.type === "factory") &&
        c.contracts.some((k) => k.type === "account_implementation"),
    );
  }

  /** Factory + implementation for one EVM chain, or null when not configured. */
  async deploymentFor(chainReference: string): Promise<{ factory: string; implementation: string } | null> {
    const chains = await this.activeChains();
    const chain = chains.find((c) => c.namespace === "eip155" && c.reference === chainReference);
    if (!chain) return null;
    const factory = chain.contracts.find((k) => k.type === "factory")?.address;
    const implementation = chain.contracts.find((k) => k.type === "account_implementation")?.address;
    if (!factory || !implementation) return null;
    return { factory, implementation };
  }

  /** One chain by reference (undefined when unknown or inactive). */
  async chainByReference(chainReference: string): Promise<RegistryChain | undefined> {
    const chains = await this.activeChains();
    return chains.find((c) => c.reference === chainReference);
  }

  /** RPC URL for a reference (row URL, else shared env fallback). */
  async rpcUrlForReference(chainReference: string): Promise<string> {
    const chain = await this.chainByReference(chainReference);
    if (chain) return this.rpcUrlFor(chain);
    return this.safeGet(`EVM_RPC_URL_${chainReference}`) ?? this.safeGet("EVM_RPC_URL") ?? "http://localhost:8545";
  }

  /** First configured RPC URL, else the shared env fallback. */
  rpcUrlFor(chain: Pick<RegistryChain, "rpcUrls" | "reference">): string {
    if (chain.rpcUrls.length > 0) return chain.rpcUrls[0];
    return (
      this.safeGet(`EVM_RPC_URL_${chain.reference}`) ?? this.safeGet("EVM_RPC_URL") ?? "http://localhost:8545"
    );
  }

  private async readRegistry(): Promise<RegistryChain[]> {
    const rows = await this.prisma.chain.findMany({
      where: { isActive: true },
      include: { contracts: { where: { isActive: true } } },
      orderBy: [{ namespace: "asc" }, { reference: "asc" }],
    });
    if (rows.length === 0) return this.codeFallback();
    return rows.map((r) => ({
      id: r.id,
      namespace: r.namespace,
      reference: r.reference,
      name: r.name,
      nativeSymbol: r.nativeSymbol,
      decimals: r.decimals,
      rpcUrls: r.rpcUrls,
      explorerUrl: r.explorerUrl,
      logoUrl: r.logoUrl,
      isTestnet: r.isTestnet,
      contracts: r.contracts.map((c) => ({ type: c.type, address: c.address, versionLabel: c.versionLabel })),
    }));
  }

  /** Compiled-in list + env contracts (pre-registry behavior). */
  private codeFallback(): RegistryChain[] {
    // getOrThrow-in-try: prod env throws when unset, while old test doubles
    // return garbage for every key — either way only valid addresses enable EVM.
    let factory: string | undefined;
    let implementation: string | undefined;
    try {
      factory = this.config.getOrThrow<string>("EVM_FACTORY_ADDRESS");
      implementation = this.config.getOrThrow<string>("EVM_IMPLEMENTATION_ADDRESS");
    } catch {
      factory = this.safeGet("EVM_FACTORY_ADDRESS");
      implementation = this.safeGet("EVM_IMPLEMENTATION_ADDRESS");
    }
    if (!isEvmAddressLike(factory) || !isEvmAddressLike(implementation)) {
      factory = undefined;
      implementation = undefined;
    }
    const refs = this.safeGet("EVM_CHAIN_REFERENCES");
    const allow = refs ? new Set(refs.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    return EVM_CHAINS.filter((c) => !allow || allow.has(c.chainReference)).map((c, i) => ({
      id: `code:${c.chainReference}`,
      namespace: c.namespace,
      reference: c.chainReference,
      name: c.name,
      nativeSymbol: c.nativeSymbol,
      decimals: 18,
      rpcUrls: [],
      explorerUrl: null,
      logoUrl: null,
      isTestnet: true,
      contracts:
        factory && implementation
          ? [
              { type: "factory", address: factory, versionLabel: "v1" },
              { type: "account_implementation", address: implementation, versionLabel: "v1" },
            ]
          : [],
    }));
  }

  private safeGet(key: string): string | undefined {
    try {
      return this.config.get<string>(key);
    } catch {
      return undefined;
    }
  }
}

function isEvmAddressLike(v: string | undefined): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
