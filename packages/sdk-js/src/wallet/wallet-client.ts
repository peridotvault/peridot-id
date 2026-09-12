// Peridot wallet client (task 009) — the PRD_v5 §9 surface over the Solana adapter.

import { PublicKey } from "@peridotvault/pid-core";
import { b64url, b64urlToBytes, buildWithdrawPayload, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import type { ParsedTx, PasskeySigner, TokenBalance, TransactionStatus } from "@peridotvault/pid-solana";
import type { Account, ApiError, Authority, WalletTransaction } from "@peridotvault/pid-types";
import { BrowserPasskeySigner } from "@peridotvault/pid-core";
import { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
import { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export interface PeridotWalletOptions {
  solanaRpcUrl: string | string[];
  feePayerStore?: SecretStore;
  passkeySigner?: PasskeySigner;
  historyStore?: HistoryStore;
}

export interface TopupInput {
  amount: string; // lamports (SOL) or raw token units, as a decimal string
  asset: string; // "SOL" or an SPL mint address
}

export interface WithdrawInput {
  amount: string;
  asset: string; // "SOL" or an SPL mint address
  to: string; // Solana address (or ATA for tokens)
}

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | ApiError }>;
}

export type ActivationStatus =
  | "inactivated"
  | "funded"
  | "ready"
  | "activating"
  | "active"
  | "insufficient";

export interface ActivationView {
  status: ActivationStatus;
  smartAccountAddress: string;
  balanceLamports: number;
  requiredLamports: number;
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && "statusCode" in v;
}

export class PeridotWallet {
  private readonly adapter: SolanaAdapter;
  private readonly feePayer: FeePayerManager;
  private readonly passkeySigner: PasskeySigner;
  private readonly historyStore: HistoryStore;

  constructor(
    private readonly api: ApiLike,
    options: PeridotWalletOptions,
  ) {
    this.adapter = new SolanaAdapter(new SolanaRpc(options.solanaRpcUrl));
    this.feePayer = new FeePayerManager(options.feePayerStore);
    this.passkeySigner = options.passkeySigner ?? new BrowserPasskeySigner();
    this.historyStore = options.historyStore ?? new LocalHistoryStore();
  }

  private async defaultAccountId(): Promise<string> {
    const res = await this.api.get<Account[]>("/v1/accounts");
    const account = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!account) throw new Error("Account not found — create an account first");
    return account.id;
  }

  /**
   * The smart-account address as stored by the API (the real deposit target). This is the
   * on-chain truth for balance reads — NOT a re-derivation, which can drift if the program
   * id changed after the account was created.
   */
  private async smartAccountAddress(): Promise<string> {
    const res = await this.api.get<Account[]>("/v1/accounts");
    const account = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!account) throw new Error("Account not found — create an account first");
    const smart = account.chainAccounts?.find((c) => c.accountType === "smart_account");
    if (!smart) throw new Error("Smart account not created");
    return smart.address;
  }

  /**
   * The EVM counterfactual address for a chain (e.g. `"97"`, `"10143"`,
   * `"421614"`), as stored by the API. Same funding-before-deploy shape as Solana.
   */
  async evmSmartAccountAddress(chainReference: string): Promise<string> {
    const res = await this.api.get<Account[]>("/v1/accounts");
    const account = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!account) throw new Error("Account not found — create an account first");
    const evm = account.chainAccounts?.find(
      (c) => c.chainNamespace === "eip155" && c.chainReference === chainReference && c.accountType === "smart_account",
    );
    if (!evm) throw new Error(`EVM smart account not created for chain ${chainReference}`);
    return evm.address;
  }

  private async authorityCompressed(): Promise<Uint8Array> {
    const res = await this.api.get<Authority[]>("/v1/credentials");
    const auth = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!auth) throw new Error("No passkey registered");
    return b64urlToBytes(auth.publicKey);
  }

  /** The default account (with the deterministic smart-account address). */
  async me(): Promise<Account | ApiError> {
    const res = await this.api.get<Account[]>("/v1/accounts");
    if (isApiError(res.data)) return res.data;
    const account = (res.data ?? [])[0];
    if (!account) return { statusCode: 404, message: "Account not found" };
    return account;
  }

  /** Create the default Peridot account (idempotent) — returns it. */
  async createAccount(): Promise<Account | ApiError> {
    const res = await this.api.post<Account>("/v1/accounts");
    return res.data;
  }

  /** Top up (deposit). The first SOL top-up also initializes the smart account (PRD_v5 §3). */
  async topup(input: TopupInput): Promise<{ signature: string }> {
    const accountId = await this.defaultAccountId();
    const feePayer = await this.feePayer.getOrCreate();
    const lamports = BigInt(input.amount);
    const authority = await this.authorityCompressed();

    const signature =
      input.asset === "SOL"
        ? await this.adapter.initializeAndDepositSol(accountId, authority, feePayer, lamports)
        : await this.adapter.depositToken(accountId, new PublicKey(input.asset), feePayer, lamports);
    return { signature };
  }

  /**
   * Relayer-sponsored withdrawal. Peridot's relayer pays the network fee (the smart account
   * is a PDA and can't), and the smart account reimburses it with a small relay fee that the
   * server quotes. The passkey signs the exact payload; the server broadcasts it.
   */
  async withdraw(input: WithdrawInput): Promise<{ signature: string; relayFeeLamports: string; status: "confirmed" | "pending" }> {
    const accountId = await this.defaultAccountId();
    const amount = BigInt(input.amount);
    const destination = new PublicKey(input.to);

    // Fresh quote — the client signs the relay fee, so it must match the server's fair fee.
    const quoteRes = await this.api.post<{ relayFeeLamports: string; chainTime: number }>("/v1/wallet/withdraw/quote", { asset: input.asset });
    if (!quoteRes.ok || "statusCode" in quoteRes.data) throw new Error("Failed to get a fee quote");
    const quote = quoteRes.data as { relayFeeLamports: string; chainTime: number };
    const relayFee = BigInt(quote.relayFeeLamports);
    const expiry = Math.floor(quote.chainTime) + 300;

    const nonce = await this.adapter.getNonce(accountId);

    const attempt = async (n: bigint): Promise<{ signature: string; relayFeeLamports: string; status: "confirmed" | "pending" }> => {
      const p = await buildWithdrawPayload(n, amount, destination, expiry, relayFee);
      const a = await this.passkeySigner.sign(p, {});
      const res = await this.api.post<{ signature: string; relayFeeLamports: string; status: "confirmed" | "pending" }>("/v1/wallet/withdraw", {
        asset: input.asset,
        to: input.to,
        amount: input.amount,
        nonce: n.toString(),
        expiry,
        relayFeeLamports: relayFee.toString(),
        assertion: {
          id: a.credentialId,
          signature: b64url(a.signature),
          authenticatorData: b64url(a.authenticatorData),
          clientDataJSON: b64url(a.clientDataJSON),
        },
      });
      if (!res.ok || "statusCode" in res.data) {
        const msg = (res.data as { message?: string | string[] }).message ?? "Withdrawal failed";
        throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
      }
      return res.data as { signature: string; relayFeeLamports: string; status: "confirmed" | "pending" };
    };

    try {
      return await attempt(nonce);
    } catch (e) {
      // Stale nonce (another tx landed in between) — re-read and retry once.
      if (e instanceof Error && /stale|newer nonce/i.test(e.message)) {
        const freshNonce = await this.adapter.getNonce(accountId);
        return attempt(freshNonce);
      }
      throw e;
    }
  }

  async waitForConfirmation(signature: string, attempts = 8, intervalMs = 1000): Promise<"confirmed" | "failed" | "pending"> {
    return this.adapter.waitForConfirmation(signature, attempts, intervalMs);
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return this.adapter.getStatus(signature);
  }

  async getBalance(): Promise<number> {
    return this.adapter.getBalanceOf(await this.smartAccountAddress());
  }

  /** SPL token balances held by the smart account (with their account/ATA addresses). */
  async tokens(): Promise<TokenBalance[]> {
    return this.adapter.getTokenBalancesOf(await this.smartAccountAddress());
  }

  /** Activate the smart account (server-side relayer). */
  async activate(accountId: string): Promise<ActivationView | ApiError> {
    const res = await this.api.post<ActivationView>(`/v1/accounts/${accountId}/activate`);
    return res.data;
  }

  /** Current activation status of the smart account. */
  async activation(accountId: string): Promise<ActivationView | ApiError> {
    const res = await this.api.get<ActivationView>(`/v1/accounts/${accountId}/activation`);
    return res.data;
  }

  /**
   * On-chain activity history: fetches confirmed signatures for the smart-account address and
   * each token ATA, parses new ones into WalletTransaction rows, and merges them into the
   * local cache (newest first). On RPC failure the cache is returned so the UI still works.
   */
  async history(limit = 30): Promise<WalletTransaction[]> {
    const smartAccount = await this.smartAccountAddress();
    const scope = smartAccount;
    const watchers = [smartAccount, ...(await this.tokens().catch(() => [])).map((t) => t.account)];

    let newlyParsed: WalletTransaction[] = [];
    try {
      // Fetch recent signatures from every watched account (skip errored txs).
      const seen = new Map<string, string>(); // signature
      for (const addr of watchers) {
        const sigs = await this.adapter.getHistory(addr, limit).catch(() => []);
        for (const s of sigs) if (s.err === null) seen.set(s.signature, s.signature);
      }
      const signatures = [...seen.keys()].slice(0, limit);

      const cached = (await this.historyStore.get(scope)) ?? [];
      const cachedSigs = new Set(cached.map((t) => t.id));
      const fresh = signatures.filter((s) => !cachedSigs.has(s));

      newlyParsed = [];
      for (const sig of fresh.slice(0, limit)) {
        const parsed = await this.adapter.parseTransaction(sig).catch(() => null);
        if (!parsed) continue;
        for (const row of parseTx(parsed, smartAccount)) newlyParsed.push(row);
      }
    } catch {
      // RPC failure — fall through to cache.
    }

    const cached = (await this.historyStore.get(scope)) ?? [];
    const merged = mergeHistory(cached, newlyParsed, limit);
    await this.historyStore.set(scope, merged).catch(() => undefined);
    return merged;
  }

  /**
   * Look up one parsed on-chain activity row by id (signature, or `signature:mint` for
   * token-only transfers). Reads the account-scoped history cache — no API round-trip.
   */
  async activity(id: string): Promise<WalletTransaction | undefined> {
    const cached = (await this.historyStore.get(await this.smartAccountAddress())) ?? [];
    return cached.find((t) => t.id === id);
  }
}

/** Parse a parsed on-chain transaction into one or more WalletTransaction rows. */
function parseTx(tx: ParsedTx, smartAccount: string): WalletTransaction[] {
  const createdAt = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString();
  const base = {
    chain: "solana",
    network: "solana",
    txHash: tx.signature,
    status: "confirmed" as const,
    confirmedAt: createdAt,
    intentId: null,
    createdAt,
  };

  const ownIdx = tx.accountKeys.findIndex((k) => k === smartAccount);
  const rows: WalletTransaction[] = [];

  if (ownIdx >= 0 && tx.preBalances && tx.postBalances) {
    const solDelta = (tx.postBalances[ownIdx] ?? 0) - (tx.preBalances[ownIdx] ?? 0);
    if (solDelta !== 0) {
      const activated = (tx.logs ?? []).some((l) => l.includes("PeridotEvent::AccountActivated"));
      rows.push({
        ...base,
        id: tx.signature,
        type: activated ? "ACTIVATION" : solDelta > 0 ? "DEPOSIT" : "WITHDRAW",
        amount: String(Math.abs(solDelta)),
        asset: "SOL",
        direction: solDelta > 0 ? "in" : "out",
        counterparty: counterpartyOf(tx, smartAccount, solDelta > 0 ? "in" : "out") ?? null,
      });
      // A single signature dominates the SOL row; skip token noise in the same tx.
      return rows;
    }
  }

  // Token-only tx: net deltas per mint across the smart-account-owned ATAs.
  const byMint = new Map<string, { delta: number; decimals: number; counter: string | null; out: boolean }>();
  for (const pre of tx.preTokenBalances ?? []) {
    if (pre.owner !== smartAccount) continue;
    const post = (tx.postTokenBalances ?? []).find((b) => b.accountIndex === pre.accountIndex);
    const delta = (post ? Number(post.amount) : 0) - Number(pre.amount);
    if (delta === 0) continue;
    const cur = byMint.get(pre.mint) ?? { delta: 0, decimals: pre.decimals, counter: null, out: false };
    cur.delta += delta;
    cur.decimals = pre.decimals;
    byMint.set(pre.mint, cur);
  }
  for (const [mint, info] of byMint) {
    rows.push({
      ...base,
      id: `${tx.signature}:${mint}`,
      type: info.delta > 0 ? "DEPOSIT" : "WITHDRAW",
      amount: String(Math.abs(info.delta)),
      asset: mint,
      direction: info.delta > 0 ? "in" : "out",
      counterparty: null,
    });
  }
  return rows;
}

/** Find the counterparty (the address that moved the opposite way from the smart account). */
function counterpartyOf(tx: ParsedTx, smartAccount: string, direction: "in" | "out"): string | null {
  if (!tx.preBalances || !tx.postBalances) return null;
  let best: string | null = null;
  let bestDelta = 0;
  for (let i = 0; i < tx.accountKeys.length; i++) {
    const addr = tx.accountKeys[i];
    if (addr === smartAccount || addr === "11111111111111111111111111111111") continue;
    const delta = (tx.postBalances[i] ?? 0) - (tx.preBalances[i] ?? 0);
    // "in" money came from the account that decreased the most (the sender);
    // "out" money went to the account that increased the most (the recipient).
    if (direction === "in" ? delta < bestDelta : delta > bestDelta) {
      bestDelta = delta;
      best = addr;
    }
  }
  return best;
}

/** Merge new rows into the cache, keep the newest `limit`, dedupe by id. */
function mergeHistory(cached: WalletTransaction[], fresh: WalletTransaction[], limit: number): WalletTransaction[] {
  const merged = new Map<string, WalletTransaction>();
  for (const t of fresh) merged.set(t.id, t);
  for (const t of cached) if (!merged.has(t.id)) merged.set(t.id, t);
  const byTime = [...merged.values()].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  return byTime.slice(0, limit * 2);
}