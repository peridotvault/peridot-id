// Admin token preview: double-check + autofill for a candidate mint before the
// admin saves it to the curated registry.
//
// Two independent sources, neither trusted blindly:
//   1. On-chain (our own RPC): mint decimals — the value the wallet formats
//      with, so it ALWAYS wins over any provider.
//   2. CoinGecko free `coins/{platform}/contract/{address}` (admin-only,
//      throttled, 1h server cache): name/symbol/logo suggestion + a second
//      decimals opinion. Mismatches come back as `conflicts` for the admin to
//      resolve — the row is never auto-saved.
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ChainRegistryService } from "../chain/chain-registry.service";

export interface TokenPreviewOnchain {
  decimals?: number;
  error?: string;
}

export interface TokenPreviewCoingecko {
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  decimalPlace: number | null;
  addressMatch: boolean;
}

export interface TokenPreview {
  chainNamespace: string;
  chainReference: string;
  mint: string;
  onchain: TokenPreviewOnchain;
  coingecko: TokenPreviewCoingecko | null;
  coingeckoSkipped?: string;
  autofill: { symbol: string; name: string; decimals: number | null; logoSourceUrl: string | null } | null;
  conflicts: string[];
}

/** CoinGecko asset-platform ids per registry chain (only mapped chains query). */
const COINGECKO_PLATFORM: Record<string, string> = {
  "solana:*": "solana",
  "eip155:1": "ethereum",
  "eip155:97": "binance-smart-chain",
  "eip155:84532": "base",
  "eip155:421614": "arbitrum-one",
};

const CG_TIMEOUT_MS = 10_000;
const CG_CACHE_TTL_MS = 3_600_000;
const cgCache = new Map<string, { at: number; value: TokenPreviewCoingecko | null }>();

function isSolanaMint(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function isEvmAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(t);
  }
}

async function rpcCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CG_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = (await res.json()) as { result?: string; error?: { message?: string } };
    if (typeof j.result !== "string") throw new Error(j.error?.message ?? "empty result");
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function evmCode(rpcUrl: string, address: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CG_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = (await res.json()) as { result?: string };
    return j.result ?? "0x";
  } finally {
    clearTimeout(t);
  }
}

@Injectable()
export class TokenPreviewService {
  constructor(private readonly chains: ChainRegistryService) {}

  /** Lazy pid-solana (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  async preview(namespace: string, reference: string, mint: string): Promise<TokenPreview> {
    if (namespace !== "solana" && namespace !== "eip155") {
      throw new BadRequestException("namespace must be solana or eip155");
    }
    const cleanMint = mint.trim();
    if (namespace === "solana" && !isSolanaMint(cleanMint)) throw new BadRequestException("Invalid Solana mint address");
    if (namespace === "eip155" && !isEvmAddress(cleanMint)) throw new BadRequestException("Invalid EVM token address");
    const chain = await this.chains.chainByReference(reference);
    if (!chain || chain.namespace !== namespace) throw new NotFoundException("Chain not registered");
    const rpcUrl = chain.rpcUrls[0];
    if (!rpcUrl) throw new BadRequestException("Chain has no RPC URL");

    let onchain: TokenPreviewOnchain;
    try {
      onchain = await this.onchainDecimals(namespace, rpcUrl, cleanMint);
    } catch (e) {
      onchain = { error: e instanceof Error ? e.message : String(e) };
    }
    const coingecko = await this.coingeckoLookup(namespace, reference, cleanMint).catch(() => null);

    const conflicts: string[] = [];
    if (onchain.decimals !== undefined && coingecko?.decimalPlace != null && onchain.decimals !== coingecko.decimalPlace) {
      conflicts.push(`decimals differ: chain=${onchain.decimals}, coingecko=${coingecko.decimalPlace} (chain wins)`);
    }
    if (coingecko && !coingecko.addressMatch) {
      conflicts.push("coingecko lists a different contract address for this coin on this chain");
    }

    return {
      chainNamespace: namespace,
      chainReference: reference,
      mint: namespace === "eip155" ? cleanMint.toLowerCase() : cleanMint,
      onchain,
      coingecko,
      coingeckoSkipped: coingecko ? undefined : "no coingecko platform mapping for this chain",
      autofill: coingecko
        ? {
            symbol: coingecko.symbol.toUpperCase(),
            name: coingecko.name,
            decimals: onchain.decimals ?? coingecko.decimalPlace,
            logoSourceUrl: coingecko.imageUrl,
          }
        : null,
      conflicts,
    };
  }

  private async onchainDecimals(namespace: string, rpcUrl: string, mint: string): Promise<TokenPreviewOnchain> {
    if (namespace === "solana") {
      const ps = this.pidSolana;
      const rpc = new ps.SolanaRpc(rpcUrl);
      const info = await rpc.connection.getParsedAccountInfo(new ps.PublicKey(mint));
      const parsed = info.value?.data;
      if (!parsed || typeof parsed !== "object" || !("parsed" in parsed)) throw new Error("Not a token mint account");
      const decimals = (parsed as { parsed: { info?: { decimals?: number } } }).parsed.info?.decimals;
      if (typeof decimals !== "number") throw new Error("Mint account has no decimals");
      return { decimals };
    }
    const code = await evmCode(rpcUrl, mint);
    if (code === "0x" || code === "0x0") throw new Error("No contract at this address");
    const raw = await rpcCall(rpcUrl, mint, "0x313ce567");
    const decimals = parseInt(raw, 16);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Bad decimals() response");
    return { decimals };
  }

  private async coingeckoLookup(namespace: string, reference: string, mint: string): Promise<TokenPreviewCoingecko | null> {
    const platform = COINGECKO_PLATFORM[`${namespace}:${reference}`] ?? (namespace === "solana" ? "solana" : undefined);
    if (!platform) return null;
    const addr = namespace === "eip155" ? mint.toLowerCase() : mint;
    const key = `${platform}:${addr}`;
    const hit = cgCache.get(key);
    if (hit && Date.now() - hit.at < CG_CACHE_TTL_MS) return hit.value;
    const j = (await fetchJson(
      `https://api.coingecko.com/api/v3/coins/${platform}/contract/${addr}`,
      CG_TIMEOUT_MS,
    )) as {
      id?: string;
      symbol?: string;
      name?: string;
      image?: { large?: string };
      platforms?: Record<string, string>;
      detail_platforms?: Record<string, { decimal_place?: number; contract_address?: string }>;
    };
    if (!j || typeof j.id !== "string") return null;
    const detail = j.detail_platforms?.[platform];
    const listed = j.platforms?.[platform];
    const value: TokenPreviewCoingecko = {
      id: j.id,
      symbol: typeof j.symbol === "string" ? j.symbol : "",
      name: typeof j.name === "string" ? j.name : "",
      imageUrl: typeof j.image?.large === "string" ? j.image.large : null,
      decimalPlace: typeof detail?.decimal_place === "number" ? detail.decimal_place : null,
      addressMatch:
        (typeof listed === "string" && listed.toLowerCase() === addr.toLowerCase()) ||
        (typeof detail?.contract_address === "string" && detail.contract_address.toLowerCase() === addr.toLowerCase()),
    };
    cgCache.set(key, { at: Date.now(), value });
    return value;
  }
}
