// Admin chain preview: verify a candidate chain row before it is saved.
//
// Two free sources, neither trusted blindly:
//   1. The candidate RPC itself: EVM `eth_chainId` must equal the reference,
//      Solana `getGenesisHash` must equal the reference. A wrong RPC is the
//      most common misconfiguration — this catches it.
//   2. Metadata suggest: EVM chainlist (chainid.network, no key, 24h server
//      cache) for name/nativeCurrency/explorer; Solana names come from the
//      known genesis constants. Mismatches come back as `conflicts`.
import { BadRequestException, Injectable } from "@nestjs/common";
import { SOLANA_DEVNET_REFERENCE, SOLANA_TESTNET_REFERENCE } from "../common/chains";

export interface ChainPreviewRpc {
  ok: boolean;
  chainId?: string;
  genesisHash?: string;
  error?: string;
}

export interface ChainPreview {
  chainNamespace: string;
  reference: string;
  rpcUrl: string;
  rpc: ChainPreviewRpc;
  suggest: { name?: string; nativeSymbol?: string; explorerUrl?: string } | null;
  conflicts: string[];
}

const TIMEOUT_MS = 10_000;
const CHAINLIST_URL = "https://chainid.network/chains.json";
const CHAINLIST_TTL_MS = 24 * 3_600_000;

interface ChainlistRow {
  chainId: number;
  name?: string;
  nativeCurrency?: { symbol?: string };
  explorers?: { url?: string }[];
}

let chainlist: { at: number; rows: ChainlistRow[] } | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(t);
  }
}

async function evmChainId(rpcUrl: string): Promise<string> {
  const j = (await fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  })) as { result?: string; error?: { message?: string } };
  if (typeof j.result !== "string") throw new Error(j.error?.message ?? "empty result");
  const id = parseInt(j.result, 16);
  if (!Number.isInteger(id)) throw new Error("bad chainId response");
  return String(id);
}

async function solanaGenesis(rpcUrl: string): Promise<string> {
  const j = (await fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
  })) as { result?: string; error?: { message?: string } };
  if (typeof j.result !== "string" || j.result.length === 0) throw new Error(j.error?.message ?? "empty result");
  return j.result;
}

const SOLANA_NAMES: Record<string, string> = {
  [SOLANA_DEVNET_REFERENCE]: "Solana Devnet",
  [SOLANA_TESTNET_REFERENCE]: "Solana Testnet",
};

@Injectable()
export class ChainPreviewService {
  async preview(namespace: string, reference: string, rpcUrl: string): Promise<ChainPreview> {
    if (namespace !== "solana" && namespace !== "eip155") {
      throw new BadRequestException("namespace must be solana or eip155");
    }
    const ref = reference.trim();
    const url = rpcUrl.trim();
    if (!ref) throw new BadRequestException("reference is required");
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException("rpcUrl must be http(s)");

    const conflicts: string[] = [];
    let rpc: ChainPreviewRpc;
    try {
      if (namespace === "eip155") {
        const chainId = await evmChainId(url);
        rpc = { ok: true, chainId };
        if (chainId !== ref) conflicts.push(`RPC serves chainId ${chainId}, not ${ref}`);
      } else {
        const genesisHash = await solanaGenesis(url);
        rpc = { ok: true, genesisHash };
        if (genesisHash !== ref) conflicts.push(`RPC genesis ${genesisHash.slice(0, 12)}… does not match reference`);
      }
    } catch (e) {
      rpc = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const suggest = await this.suggest(namespace, ref).catch(() => null);
    return { chainNamespace: namespace, reference: ref, rpcUrl: url, rpc, suggest, conflicts };
  }

  private async suggest(namespace: string, ref: string): Promise<ChainPreview["suggest"]> {
    if (namespace === "solana") {
      const name = SOLANA_NAMES[ref];
      return name ? { name, nativeSymbol: "SOL", explorerUrl: "https://explorer.solana.com" } : null;
    }
    const id = Number(ref);
    if (!Number.isInteger(id)) return null;
    if (!chainlist || Date.now() - chainlist.at >= CHAINLIST_TTL_MS) {
      const rows = (await fetchJson(CHAINLIST_URL)) as unknown;
      if (!Array.isArray(rows)) return null;
      chainlist = { at: Date.now(), rows: rows as ChainlistRow[] };
    }
    const row = chainlist.rows.find((r) => r.chainId === id);
    if (!row) return null;
    return {
      name: typeof row.name === "string" ? row.name : undefined,
      nativeSymbol: typeof row.nativeCurrency?.symbol === "string" ? row.nativeCurrency.symbol : undefined,
      explorerUrl: typeof row.explorers?.[0]?.url === "string" ? row.explorers[0].url : undefined,
    };
  }
}
