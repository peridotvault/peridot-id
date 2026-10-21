// Chain registry — admin-managed chains + typed contracts (DB first, code fallback).
//
// Reads never throw for missing tables/rows: an empty registry (fresh local dev,
// old unit-test doubles) falls back to the compiled-in chain list with NO
// contracts, so EVM stays off until an admin registers factory/implementation
// rows. Chains, RPC URLs, program/contract addresses, and the EVM relayer key
// are dashboard-managed — never env (ANT-193 dropped every EVM_* variable).

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { EVM_CHAINS } from "@peridotvault/pid-core/dist/evm";
import {
  MAX_CHAIN_REFERENCE_LENGTH,
  SOLANA_DEVNET_REFERENCE,
  SOLANA_DEVNET_RPC,
  SOLANA_NAMESPACE,
  SOLANA_PROGRAM_ID,
  SOLANA_TESTNET_PROGRAM_ID,
  SOLANA_TESTNET_REFERENCE,
  SolanaSelection,
  UNKNOWN_CHAIN_CODE,
  solanaReferenceFor,
} from "../common/chains";
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

/**
 * Mainnet Solana presence signal (ANT-75). Single source of truth for
 * "does a mainnet Solana program exist": true only when an ACTIVE
 * non-testnet `solana` registry row carries a `program` contract address.
 * The seeded registry has no such row (both Solana rows are testnet), so
 * this reads `available: false` until a mainnet program ships as a data row
 * (no code change, no migration — adding the row flips the signal).
 */
export interface SolanaMainnetAvailability {
  available: boolean;
  reference: string | null;
  program: string | null;
  rpcUrl: string | null;
}

const CACHE_TTL_MS = 30_000;

/** Local-dev EVM default when no registry row carries an RPC URL. */
const DEFAULT_EVM_RPC_URL = "http://localhost:8545";

@Injectable()
export class ChainRegistryService {
  private cache: { at: number; chains: RegistryChain[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

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

  /**
   * Solana chain id or clean 404 — chain_accounts has a hard FK to it, so
   * writers fail fast here (not P2003) when the registry row is missing.
   * Fresh DBs must run db:seed first. The optional selection scopes the
   * lookup to the devnet/testnet row; omitted (default) preserves the
   * historical behavior of resolving the default (devnet) row.
   */
  async solanaChainIdOrThrow(selection?: SolanaSelection): Promise<string> {
    const reference = solanaReferenceFor(selection ?? "devnet");
    const row = await this.prisma.chain.findUnique({
      where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference } },
      select: { id: true },
    });
    if (!row) {
      if (!selection) throw new NotFoundException("Solana chain is not registered — run db:seed");
      throw new NotFoundException(`Solana chain is not registered for "${selection}" — run db:seed`);
    }
    return row.id;
  }

  /** All active Solana chains (devnet + testnet in dual-cluster mode). */
  async solanaChains(): Promise<RegistryChain[]> {
    const chains = await this.activeChains();
    return chains.filter((c) => c.namespace === SOLANA_NAMESPACE);
  }

  /**
   * The active Solana chain for a selection (undefined when the registry has
   * none). No selection = historical behavior: the first active Solana row
   * (the devnet row on seeded DBs).
   */
  async solanaChain(selection?: SolanaSelection): Promise<RegistryChain | undefined> {
    const chains = await this.solanaChains();
    if (!selection) return chains[0];
    return chains.find((c) => c.reference === solanaReferenceFor(selection));
  }

  /** Solana RPC for a selection (registry row, else public devnet as last resort). */
  async solanaRpcUrl(selection?: SolanaSelection): Promise<string> {
    const chain = await this.solanaChain(selection);
    return chain?.rpcUrls[0] ?? SOLANA_DEVNET_RPC;
  }

  /** Solana program id for a selection (`program` contract, else per-cluster constant). */
  async solanaProgramId(selection?: SolanaSelection): Promise<string> {
    const chain = await this.solanaChain(selection);
    return (
      chain?.contracts.find((k) => k.type === "program")?.address ??
      (selection === "testnet" ? SOLANA_TESTNET_PROGRAM_ID : SOLANA_PROGRAM_ID)
    );
  }

  /**
   * Mainnet Solana presence signal (ANT-75, served at
   * `GET /v1/chains/solana-availability`). Reads the cached `activeChains()`
   * (30s TTL, no extra DB query, no N+1) so the wallet can hide Solana
   * create/activate UI in mainnet mode until a mainnet program exists
   * (ANT-73). Fail-absent: anything short of an active non-testnet solana
   * row WITH a program contract reads as unavailable.
   */
  async solanaMainnetAvailability(): Promise<SolanaMainnetAvailability> {
    const chains = await this.activeChains();
    const row = chains.find((c) => c.namespace === SOLANA_NAMESPACE && !c.isTestnet);
    const program = row?.contracts.find((k) => k.type === "program")?.address ?? null;
    if (!row || !program) return { available: false, reference: null, program: null, rpcUrl: null };
    return { available: true, reference: row.reference, program, rpcUrl: row.rpcUrls[0] ?? null };
  }

  /**
   * Activity/explorer label for a registry chain (no SOLANA_NETWORK env).
   * Centralizes the rule previously duplicated in activation + intent:
   * non-testnet rows are mainnet-beta, the testnet row is testnet, and
   * anything else (including an empty registry) reads as devnet.
   */
  networkLabelFor(chain: Pick<RegistryChain, "reference" | "isTestnet"> | undefined): string {
    if (chain && !chain.isTestnet) return "mainnet-beta";
    if (chain?.reference === SOLANA_TESTNET_REFERENCE) return "testnet";
    return "devnet";
  }

  /** Activity label for the selected chain (default = current behavior). */
  async networkLabel(selection?: SolanaSelection): Promise<string> {
    return this.networkLabelFor(await this.solanaChain(selection));
  }

  /**
   * HTTP-surface resolver (ANT-35, spec §8): map a client-supplied chain
   * reference (`X-Chain-Reference` header, `?chainReference` query fallback)
   * to a Solana selection. Omitted/blank preserves the server default
   * (current behavior, AC-1.3). Unknown, over-long, or inactive references
   * fail closed with 400 UNKNOWN_CHAIN and no chain write (AC-1.4).
   * Header wins over query — controllers pass `header ?? query` in.
   */
  async selectionFromReferenceOrThrow(reference?: string | string[]): Promise<SolanaSelection | undefined> {
    if (Array.isArray(reference)) {
      throw new BadRequestException({ code: UNKNOWN_CHAIN_CODE, message: "Ambiguous chain reference" });
    }
    const ref = reference?.trim();
    if (!ref) return undefined;
    const failClosed = (message: string): never => {
      throw new BadRequestException({ code: UNKNOWN_CHAIN_CODE, message });
    };
    if (ref.length > MAX_CHAIN_REFERENCE_LENGTH) failClosed(`Unknown chain reference "${ref.slice(0, 32)}…"`);
    const chain = (await this.solanaChains()).find((c) => c.reference === ref);
    if (!chain) {
      throw new BadRequestException({ code: UNKNOWN_CHAIN_CODE, message: `Unknown chain reference "${ref}"` });
    }
    if (chain.reference === SOLANA_TESTNET_REFERENCE) return "testnet";
    if (chain.reference === SOLANA_DEVNET_REFERENCE) return "devnet";
    // Active Solana row with no served selection (e.g. a future third row):
    // fail closed rather than silently serving another cluster (offline case, §11).
    return failClosed(`Chain reference "${ref}" is not served by this API version`);
  }

  /** RPC URL for a reference (registry row URL, else the local-dev default). */
  async rpcUrlForReference(chainReference: string): Promise<string> {
    const chain = await this.chainByReference(chainReference);
    if (chain) return this.rpcUrlFor(chain);
    return DEFAULT_EVM_RPC_URL;
  }

  /** First configured RPC URL, else the local-dev default. */
  rpcUrlFor(chain: Pick<RegistryChain, "rpcUrls" | "reference">): string {
    if (chain.rpcUrls.length > 0) return chain.rpcUrls[0];
    return DEFAULT_EVM_RPC_URL;
  }

  /**
   * EVM relayer private key for a chain (dashboard-managed `evm_relayer_keys`
   * row, admin-only writes). Null when unset — callers fail over to the
   * operator forge-script flow. Never throws (missing table/row = unset) and
   * never logs the secret. Flagged for ANT-195 security review.
   */
  async relayerSecretFor(chainReference: string): Promise<string | null> {
    try {
      const chain = await this.chainByReference(chainReference);
      if (!chain) return null;
      const row = await this.prisma.evmRelayerKey.findUnique({ where: { chainId: chain.id } });
      const secret = row?.secret;
      return typeof secret === "string" && secret.length > 0 ? secret : null;
    } catch {
      return null;
    }
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

  /** Compiled-in chain list with no contracts (EVM off until admin registers rows). */
  private codeFallback(): RegistryChain[] {
    return EVM_CHAINS.map((c) => ({
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
      contracts: [],
    }));
  }
}
