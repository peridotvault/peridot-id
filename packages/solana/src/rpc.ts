// Replaceable Solana RPC abstraction (PRD_v4 §19, web3.js layering rule). The API/SDK talks to this,
// never to @solana/web3.js directly. Provider is config, not code.
//
// Multi-endpoint failover: `SolanaRpc` accepts one or more RPC URLs; the
// current endpoint is health-checked and, on a failed call, the client rotates to the next
// endpoint. A malicious/lying RPC can misreport but cannot forge execution — confirmation
// is read against cluster state (commitment), not a single node's word.

import {
  ConfirmedSignatureInfo,
  Connection,
  type AccountInfo,  type Finality,
  type Keypair,
  ParsedTransactionWithMeta,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

export interface ParsedTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  fee?: number;
  accountKeys: string[];
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: ParsedTokenBalance[];
  postTokenBalances?: ParsedTokenBalance[];
  logs?: string[];
  computeUnitsConsumed?: number;
}

export interface ParsedTokenBalance {
  mint: string;
  owner: string;
  accountIndex: number;
  amount: string;
  decimals: number;
}

export interface ChainRpc {
  getLatestBlockhash(): Promise<string>;
  sendTransaction(tx: Transaction, signers?: Keypair[]): Promise<string>;
  getTransaction(sig: string): Promise<{ err: unknown; computeUnitsConsumed?: number; logs?: string[] } | null>;
  getParsedTransaction(sig: string): Promise<ParsedTx | null>;
  getSignaturesForAddress(address: PublicKey, limit?: number): Promise<{ signature: string; err: unknown }[]>;
  getBalance(address: PublicKey): Promise<number>;
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
  /** Chain clock (used for passkey authorization expiries — the program checks the Clock sysvar). */
  getBlockTime(): Promise<number>;
  getTokenAccountsByOwner(owner: PublicKey): Promise<TokenBalance[]>;
}

export interface TokenBalance {
  mint: string;
  /** Raw token-account balance (not scaled by decimals). */
  amount: string;
  decimals: number;
  /** The token account (ATA) that holds the balance at this address. */
  account: string;
}

export interface NftItem {
  mint: string;
  name?: string;
  image?: string;
  uri?: string;
}

// Canonical id from mpl-token-metadata programs/token-metadata/program/src/lib.rs.
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const NFT_SCAN_LIMIT = 20;
const METADATA_URI_MAX = 200;
const OFFCHAIN_JSON_MAX = 256_000;
const OFFCHAIN_TIMEOUT_MS = 8000;

/** Read a Metaplex Borsh string (u32 LE len + utf8, null-padded) with bounds checks. */
export function parseMetadataString(buf: Buffer, offset: number, max: number): { value: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32LE(offset);
  if (len > max) return null;
  const start = offset + 4;
  if (start + max > buf.length) return null;
  const value = buf.subarray(start, start + Math.min(len, max)).toString("utf8").replace(/\0+$/g, "").trim();
  return { value, next: start + max };
}

/**
 * Extract the offchain JSON uri from a Metaplex Token Metadata account.
 * Layout: key(1) + updateAuthority(32) + mint(32) + name(4+32) + symbol(4+10) + uri(4+200).
 */
export function parseMetadataUri(data: Buffer): string | undefined {
  const name = parseMetadataString(data, 1 + 32 + 32, 32);
  if (!name) return undefined;
  const symbol = parseMetadataString(data, name.next, 10);
  if (!symbol) return undefined;
  const uri = parseMetadataString(data, symbol.next, METADATA_URI_MAX);
  const value = uri?.value;
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  return value;
}

async function fetchOffchainMeta(uri: string): Promise<{ name?: string; image?: string } | undefined> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OFFCHAIN_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > OFFCHAIN_JSON_MAX) return undefined;
    const j = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    const name = typeof j.name === "string" ? j.name.slice(0, 128) : undefined;
    const image = typeof j.image === "string" && /^https?:\/\//i.test(j.image) ? j.image.slice(0, 512) : undefined;
    return { name, image };
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Heuristic NFT discovery (classic SPL only — misses Token-2022 and cNFTs,
 * which need DAS). Candidates: decimals 0 + balance 1. Offchain JSON is
 * untrusted: timeouts, size caps, mint fallback on any failure.
 */
export async function getNftsOf(rpc: ChainRpc, owner: PublicKey, limit = NFT_SCAN_LIMIT): Promise<NftItem[]> {
  const balances = await rpc.getTokenAccountsByOwner(owner);
  const candidates = balances.filter((b) => b.decimals === 0 && b.amount === "1").slice(0, limit);
  const out: NftItem[] = [];
  for (const c of candidates) {
    let mint: PublicKey;
    try {
      mint = new PublicKey(c.mint);
    } catch {
      continue;
    }
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID,
    );
    const info = await rpc.getAccountInfo(pda).catch(() => null);
    const uri = info?.data ? parseMetadataUri(info.data) : undefined;
    if (!uri) {
      out.push({ mint: c.mint });
      continue;
    }
    const meta = await fetchOffchainMeta(uri);
    out.push({ mint: c.mint, uri, name: meta?.name, image: meta?.image });
  }
  return out;
}

const DEFAULT_COMMITMENT: Finality = "confirmed";

export class SolanaRpc implements ChainRpc {
  private readonly connections: Connection[];
  private current = 0;
  private healthy = true;

  constructor(
    endpoints: string | string[],
    private readonly commitment: Finality = DEFAULT_COMMITMENT,
  ) {
    const urls = typeof endpoints === "string" ? [endpoints] : endpoints;
    if (urls.length === 0) throw new Error("at least one RPC endpoint required");
    this.connections = urls.map((url) => new Connection(url, commitment as Finality));
  }

  /** The active Connection (primary unless it has failed over). */
  get connection(): Connection {
    return this.connections[this.current];
  }

  /** Rotate to the next endpoint; health-check it, then mark the client healthy again. */
  async failover(): Promise<void> {
    const next = (this.current + 1) % this.connections.length;
    this.current = next;
    this.healthy = false;
    try {
      await this.connections[next].getSlot();
      this.healthy = true;
    } catch {
      // next endpoint is also down; rotate on the next call
    }
  }

  private async withFailover<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    try {
      return await fn(this.connections[this.current]);
    } catch (err) {
      if (this.connections.length > 1 && this.healthy) {
        await this.failover();
        return fn(this.connections[this.current]);
      }
      throw err;
    }
  }

  getLatestBlockhash(): Promise<string> {
    return this.withFailover((c) => c.getLatestBlockhash(this.commitment)).then((r) => r.blockhash);
  }

  sendTransaction(tx: Transaction, signers: Keypair[] = []): Promise<string> {
    // The secp256r1 precompile does not simulate correctly; rely on real execution
    // (task 005 finding). skipPreflight avoids the flaky simulation.
    return this.withFailover((c) => c.sendTransaction(tx, signers, { skipPreflight: true }));
  }

  async getTransaction(sig: string) {
    const meta = await this.withFailover((c) =>
      c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: this.commitment }),
    );
    if (!meta) return null;
    return {
      err: meta.meta?.err ?? null,
      computeUnitsConsumed: meta.meta?.computeUnitsConsumed,
      logs: meta.meta?.logMessages ?? [],
    };
  }

  async getParsedTransaction(sig: string): Promise<ParsedTx | null> {
    const meta = await this.withFailover((c) =>
      c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: this.commitment }),
    );
    if (!meta || !meta.meta) return null;
    return {
      signature: sig,
      slot: meta.slot,
      blockTime: meta.blockTime ?? null,
      err: meta.meta.err ?? null,
      fee: meta.meta.fee,
      accountKeys: meta.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
      preBalances: meta.meta.preBalances,
      postBalances: meta.meta.postBalances,
      preTokenBalances: (meta.meta.preTokenBalances ?? []).map(toParsedTokenBal),
      postTokenBalances: (meta.meta.postTokenBalances ?? []).map(toParsedTokenBal),
      logs: meta.meta.logMessages ?? [],
      computeUnitsConsumed: meta.meta.computeUnitsConsumed,
    };
  }

  async getSignaturesForAddress(address: PublicKey, limit = 30): Promise<{ signature: string; err: unknown }[]> {
    const sigs = await this.withFailover((c) =>
      c.getSignaturesForAddress(address, { limit }, this.commitment),
    );
    return sigs.map((s: ConfirmedSignatureInfo) => ({ signature: s.signature, err: s.err }));
  }

  getBalance(address: PublicKey): Promise<number> {
    return this.withFailover((c) => c.getBalance(address, this.commitment));
  }

  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return this.withFailover((c) => c.getAccountInfo(address, this.commitment));
  }

  async getBlockTime(): Promise<number> {
    const slot = await this.withFailover((c) => c.getSlot(this.commitment));
    const time = await this.withFailover((c) => c.getBlockTime(slot));
    if (time === null) throw new Error("block time unavailable");
    return time;
  }

  getTokenAccountsByOwner(owner: PublicKey): Promise<TokenBalance[]> {
    return this.withFailover(async (c) => {
      const res = await c.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
      return res.value.map((v) => {
        const info = v.account.data.parsed.info;
        return {
          mint: (info.mint as string) ?? "",
          amount: (info.tokenAmount.amount as string) ?? "0",
          decimals: (info.tokenAmount.decimals as number) ?? 0,
          account: v.pubkey.toBase58(),
        };
      });
    });
  }
}

function toParsedTokenBal(t: {
  mint: string;
  owner?: string;
  accountIndex: number;
  uiTokenAmount: { amount: string; decimals: number };
}): ParsedTokenBalance {
  return {
    mint: t.mint,
    owner: t.owner ?? "",
    accountIndex: t.accountIndex,
    amount: t.uiTokenAmount.amount,
    decimals: t.uiTokenAmount.decimals,
  };
}

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
