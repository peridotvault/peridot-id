// Peridot wallet client (task 009) — the PRD_v5 §9 surface over the Solana adapter.

import { PublicKey } from "@peridotvault/pid-core";
import { b64url, b64urlToBytes, buildActivatePayload, buildActivatePayloadV2, buildActivatePayloadV3, buildExecutePayloadV3, buildUpdateAuthorityPayloadV2, buildUpdateAuthorityPayloadV3, buildWithdrawPayload, buildWithdrawPayloadV2, buildWithdrawPayloadV3, buildWithdrawTokenPayload, buildWithdrawTokenPayloadV2, buildWithdrawTokenPayloadV3, executeCallHash, pidToSeed32, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import type { NftItem, ParsedTx, PasskeySigner, TokenBalance, TransactionStatus } from "@peridotvault/pid-solana";
import type { ApiError, Authority, Chain, ChainAccount, WalletTransaction } from "@peridotvault/pid-types";
import { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
import { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export interface PeridotWalletOptions {
  feePayerStore?: SecretStore;
  /**
   * Inline passkey signer — first-party PeridotID origin only. Omitted on
   * third-party origins: trust-critical methods then delegate to a popup on
   * `popupBaseUrl` (visible address bar) instead of signing in the dev DOM.
   */
  passkeySigner?: PasskeySigner;
  /** Popup host for delegated ceremonies (no prod default — caller-supplied). */
  popupBaseUrl?: string;
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

export interface ExecuteMetaInput {
  address: string;
  writable: boolean;
  signer: boolean;
}

export interface ExecuteInput {
  target: string; // target program (never the smart-account program)
  metas: ExecuteMetaInput[]; // bound CPI accounts, in order (PDA as signer required)
  data: string; // base64url inner instruction data (≤ 10_240 bytes)
}

interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
  post<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T | ApiError }>;
  /** Popup delegation (present on PeridotClient; absent on bare mocks). */
  popupRequest?<T>(action: string, payload?: unknown): Promise<T>;
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
  networkFeeLamports: number;
  protocolFeeBps: number;
  chainTime: number;
  treasury: string;
  feePolicyVersion: number;
  /** base64url sha256 of the WebAuthn RP ID (bound into the activation payload). */
  rpIdHash: string;
}

export interface RotateInput {
  /** Credential id of the current (signing) authority. Defaults to the first active credential. */
  oldCredentialId?: string;
  /** Credential id of the already-registered replacement authority. */
  newCredentialId: string;
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && "statusCode" in v;
}

export class PeridotWallet {
  private adapterPromise: Promise<SolanaAdapter> | null = null;
  private readonly feePayer: FeePayerManager;
  private readonly passkeySigner: PasskeySigner | undefined;
  private readonly historyStore: HistoryStore;

  constructor(
    private readonly api: ApiLike,
    options: PeridotWalletOptions,
  ) {
    this.feePayer = new FeePayerManager(options.feePayerStore);
    // No silent inline default: an explicit signer means "this IS the trusted
    // origin" (first-party wallet / hosted popup page). Otherwise trust-critical
    // methods delegate to the popup (viaPopup throws without popupRequest).
    this.passkeySigner = options.passkeySigner;
    this.historyStore = options.historyStore ?? new LocalHistoryStore();
  }

  /**
   * Solana adapter, resolved once from the API chain registry (active `solana`
   * chain → first RPC URL + the `program` contract address). Chain/RPC config
   * lives in the DB registry, not in SDK options or env.
   */
  private async solana(): Promise<SolanaAdapter> {
    if (!this.adapterPromise) {
      this.adapterPromise = (async () => {
        const res = await this.api.get<Chain[]>("/v1/chains");
        if (!res.ok || isApiError(res.data) || !Array.isArray(res.data)) {
          throw new Error("Failed to load the chain registry");
        }
        const chain = (res.data as Chain[]).find((c) => c.namespace === "solana");
        const rpcUrl = chain?.rpcUrls?.[0];
        const program = chain?.contracts?.find((k) => k.type === "program")?.address;
        if (!chain || !rpcUrl) throw new Error("Solana chain is not configured");
        if (!program) throw new Error("Solana program contract is not configured");
        return new SolanaAdapter(new SolanaRpc(rpcUrl), new PublicKey(program));
      })();
    }
    return this.adapterPromise;
  }

  /** Inline signer — throws a routable error when the caller runs popup-mode. */
  private signer(): PasskeySigner {
    if (!this.passkeySigner) {
      throw new Error(
        "No passkey signer configured — signing inline is first-party-origin only. " +
          "Pass popupBaseUrl to delegate to the PeridotID popup, or pass an explicit passkeySigner.",
      );
    }
    return this.passkeySigner;
  }

  /** Delegate one trust-critical action to the PeridotID popup. */
  private viaPopup<T>(action: string, payload?: unknown): Promise<T> {
    if (!this.api.popupRequest) {
      throw new Error(
        `Cannot ${action} without a passkey signer or popup — pass popupBaseUrl (popup flow) or passkeySigner (first-party origin).`,
      );
    }
    return this.api.popupRequest<T>(action, payload);
  }

  private cachedPid: string | null = null;

  /** The token identity's PID — also the seed for every address derivation. Cached. */
  private async pid(): Promise<string> {
    if (!this.cachedPid) {
      const res = await this.api.get<{ pid: string }>("/v1/identity/me");
      if (!res.ok || isApiError(res.data)) throw new Error("Not signed in");
      this.cachedPid = (res.data as { pid: string }).pid;
    }
    return this.cachedPid;
  }

  private async chains(): Promise<ChainAccount[]> {
    const res = await this.api.get<ChainAccount[]>("/v1/account");
    if (!res.ok || isApiError(res.data)) throw new Error("Account not found — create an account first");
    return res.data as ChainAccount[];
  }

  /**
   * The smart-account address as stored by the API (the real deposit target). This is the
   * on-chain truth for balance reads — NOT a re-derivation, which can drift if the program
   * id changed after the account was created.
   */
  private async smartAccountAddress(): Promise<string> {
    const rows = await this.chains();
    const smart = rows.find((c) => c.accountType === "smart_account");
    if (!smart) throw new Error("Smart account not created");
    return smart.address;
  }

  /**
   * The EVM counterfactual address for a chain (e.g. `"97"`, `"10143"`,
   * `"421614"`), as stored by the API. Same funding-before-deploy shape as Solana.
   */
  async evmSmartAccountAddress(chainReference: string): Promise<string> {
    const rows = await this.chains();
    const evm = rows.find(
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

  /** The wallet's chain rows (idempotent setup lives in createAccount). */
  async me(): Promise<ChainAccount[] | ApiError> {
    const res = await this.api.get<ChainAccount[]>("/v1/account");
    return res.data;
  }

  /** Ensure the wallet (idempotent) — returns its chain rows. */
  async createAccount(): Promise<ChainAccount[] | ApiError> {
    const res = await this.api.post<ChainAccount[]>("/v1/account");
    return res.data;
  }

  /**
   * Top up (deposit). Plain transfer only — account creation is a separate,
   * backend-gated + passkey-signed step (`activate()`), so topping up an
   * uninitialized address just funds it for later activation.
   */
  async topup(input: TopupInput): Promise<{ signature: string }> {
    if (!this.passkeySigner) return this.viaPopup("topup", input);
    const pid = await this.pid();
    const feePayer = await this.feePayer.getOrCreate();
    const lamports = BigInt(input.amount);

    const adapter = await this.solana();
    const signature =
      input.asset === "SOL"
        ? await adapter.depositSol(pid, feePayer, lamports)
        : await adapter.depositToken(pid, new PublicKey(input.asset), feePayer, lamports);
    return { signature };
  }

  /**
   * Relayer-sponsored withdrawal (V3). Peridot's relayer pays the network fee (the smart
   * account is a PDA and can't); the smart account reimburses the attested network cost
   * in full plus the on-chain-recomputed protocol fee. The client signs the intent plus
   * the fee policy (never amounts) and echoes the quoted network fee as the drift
   * reference; the server re-quotes once if fees moved beyond the drift bound.
   */
  async withdraw(input: WithdrawInput): Promise<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }> {
    if (!this.passkeySigner) return this.viaPopup("withdraw", input);
    const pid = await this.pid();
    const amount = BigInt(input.amount);
    const destination = new PublicKey(input.to);
    const accountId = pidToSeed32(pid);
    const adapter = await this.solana();

    const getQuote = async () => {
      const quoteRes = await this.api.post<{ networkFeeLamports: string; protocolFeeBps: number; feePolicyVersion: number; totalFeeLamports: string; chainTime: number; treasury: string }>(
        "/v1/wallet/withdraw/quote",
        { asset: input.asset },
      );
      if (!quoteRes.ok || "statusCode" in quoteRes.data) throw new Error("Failed to get a fee quote");
      return quoteRes.data as { networkFeeLamports: string; protocolFeeBps: number; feePolicyVersion: number; totalFeeLamports: string; chainTime: number; treasury: string };
    };

    const attempt = async (
      n: bigint,
      quote: { networkFeeLamports: string; feePolicyVersion: number; chainTime: number },
    ): Promise<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }> => {
      const expiry = Math.floor(quote.chainTime) + 300;
      const p =
        input.asset === "SOL"
          ? await buildWithdrawPayloadV3(accountId, n, amount, destination, expiry, quote.feePolicyVersion)
          : await buildWithdrawTokenPayloadV3(
              accountId,
              n,
              amount,
              destination,
              expiry,
              quote.feePolicyVersion,
              await adapter.tokenAta(pid, new PublicKey(input.asset)),
            );
      const a = await this.signer().sign(p, {});
      const res = await this.api.post<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }>("/v1/wallet/withdraw", {
        asset: input.asset,
        to: input.to,
        amount: input.amount,
        nonce: n.toString(),
        expiry,
        feePolicyVersion: quote.feePolicyVersion,
        quotedNetworkFeeLamports: quote.networkFeeLamports,
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
      return res.data as { signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" };
    };

    const nonce = await adapter.getNonce(pid);
    const quote = await getQuote();
    try {
      return await attempt(nonce, quote);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      // Stale nonce (another tx landed in between) — re-read and retry once.
      if (/stale|newer nonce/i.test(e.message)) {
        const freshNonce = await adapter.getNonce(pid);
        return attempt(freshNonce, quote);
      }
      // Network fee moved beyond the drift bound — re-quote once and sign fresh intent.
      if (/moved — re-quote|re-quote/i.test(e.message)) {
        const fresh = await getQuote();
        const freshNonce = await adapter.getNonce(pid);
        return attempt(freshNonce, fresh);
      }
      throw e;
    }
  }

  /**
   * Relayer-sponsored generic execute (V3, disc 6) — wallet parity with the EVM
   * `execute`: one passkey-signed intent drives an arbitrary Solana call with
   * the PDA as signer. The client signs `call_hash` (target ‖ metas ‖ data) plus
   * the fee policy; the server re-quotes once if fees moved beyond the drift bound.
   */
  async execute(input: ExecuteInput): Promise<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }> {
    if (!this.passkeySigner) return this.viaPopup("execute", input);
    const pid = await this.pid();
    const accountId = pidToSeed32(pid);
    const adapter = await this.solana();
    const target = new PublicKey(input.target);
    const metas = input.metas.map((m) => ({ address: new PublicKey(m.address), writable: m.writable, signer: m.signer }));
    const data = b64urlToBytes(input.data);

    const getQuote = async () => {
      const quoteRes = await this.api.post<{ networkFeeLamports: string; protocolFeeBps: number; feePolicyVersion: number; totalFeeLamports: string; chainTime: number; treasury: string }>(
        "/v1/wallet/execute/quote",
        { target: input.target, metas: input.metas, data: input.data },
      );
      if (!quoteRes.ok || "statusCode" in quoteRes.data) throw new Error("Failed to get a fee quote");
      return quoteRes.data as { networkFeeLamports: string; protocolFeeBps: number; feePolicyVersion: number; totalFeeLamports: string; chainTime: number; treasury: string };
    };

    const attempt = async (
      n: bigint,
      quote: { networkFeeLamports: string; feePolicyVersion: number; chainTime: number },
    ): Promise<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }> => {
      const expiry = Math.floor(quote.chainTime) + 300;
      const callHash = await executeCallHash(target, metas, data);
      const p = await buildExecutePayloadV3(accountId, n, expiry, quote.feePolicyVersion, callHash);
      const a = await this.signer().sign(p, {});
      const res = await this.api.post<{ signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" }>("/v1/wallet/execute", {
        target: input.target,
        metas: input.metas,
        data: input.data,
        nonce: n.toString(),
        expiry,
        feePolicyVersion: quote.feePolicyVersion,
        quotedNetworkFeeLamports: quote.networkFeeLamports,
        assertion: {
          id: a.credentialId,
          signature: b64url(a.signature),
          authenticatorData: b64url(a.authenticatorData),
          clientDataJSON: b64url(a.clientDataJSON),
        },
      });
      if (!res.ok || "statusCode" in res.data) {
        const msg = (res.data as { message?: string | string[] }).message ?? "Execute failed";
        throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
      }
      return res.data as { signature: string; networkFeeLamports: string; protocolFeeLamports: string; status: "confirmed" | "pending" };
    };

    const nonce = await adapter.getNonce(pid);
    const quote = await getQuote();
    try {
      return await attempt(nonce, quote);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      // Stale nonce (another tx landed in between) — re-read and retry once.
      if (/stale|newer nonce/i.test(e.message)) {
        const freshNonce = await adapter.getNonce(pid);
        return attempt(freshNonce, quote);
      }
      // Network fee moved beyond the drift bound — re-quote once and sign fresh intent.
      if (/moved — re-quote|re-quote/i.test(e.message)) {
        const fresh = await getQuote();
        const freshNonce = await adapter.getNonce(pid);
        return attempt(freshNonce, fresh);
      }
      throw e;
    }
  }

  async waitForConfirmation(signature: string, attempts = 8, intervalMs = 1000): Promise<"confirmed" | "failed" | "pending"> {
    return (await this.solana()).waitForConfirmation(signature, attempts, intervalMs);
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return (await this.solana()).getStatus(signature);
  }

  async getBalance(): Promise<number> {
    return (await this.solana()).getBalanceOf(await this.smartAccountAddress());
  }

  /** SPL token balances held by the smart account (with their account/ATA addresses). */
  async tokens(): Promise<TokenBalance[]> {
    return (await this.solana()).getTokenBalancesOf(await this.smartAccountAddress());
  }

  /** Heuristic NFT inventory (SPL 0-decimal ×1; misses Token-2022/cNFTs — no DAS). */
  async nfts(): Promise<NftItem[]> {
    return (await this.solana()).getNftsOf(await this.smartAccountAddress());
  }

  /**
   * Activate the smart account (V3). The claim is passkey-signed (payload binds op-tag,
   * account, authority, RP-ID hash, policy, expiry — no amounts) so nobody else can
   * squat the PDA or change the fee policy; the server's relayer only submits.
   * Reads the live view first for policy + chain time.
   */
  async activate(): Promise<ActivationView | ApiError> {
    if (!this.passkeySigner) return this.viaPopup("activate");
    const pid = await this.pid();
    const viewRes = await this.activation();
    if (isApiError(viewRes)) return viewRes;
    const authority = await this.authorityCompressed();
    const rpIdHash = b64urlToBytes(viewRes.rpIdHash);
    const expiry = Math.floor(viewRes.chainTime) + 300;
    const payload = await buildActivatePayloadV3(
      pidToSeed32(pid),
      authority,
      rpIdHash,
      viewRes.feePolicyVersion,
      expiry,
    );
    const a = await this.signer().sign(payload, {});
    const res = await this.api.post<ActivationView>(`/v1/account/activate`, {
      expiry,
      feePolicyVersion: viewRes.feePolicyVersion,
      quotedNetworkFeeLamports: viewRes.networkFeeLamports.toString(),
      assertion: {
        id: a.credentialId,
        signature: b64url(a.signature),
        authenticatorData: b64url(a.authenticatorData),
        clientDataJSON: b64url(a.clientDataJSON),
      },
    });
    return res.data;
  }

  /**
   * Credential lifecycle rotation (V2): the replacement credential must already be
   * registered (via the approval flow). The CURRENT key signs the rotation
   * authorization; the server submits it and revokes the old credential only after
   * the chain confirms the new authority.
   */
  async rotate(input: RotateInput): Promise<{ signature: string; status: "confirmed" | "pending" }> {
    if (!this.passkeySigner) return this.viaPopup("rotate", input);
    const pid = await this.pid();
    const credsRes = await this.api.get<Authority[]>("/v1/credentials");
    if (!credsRes.ok || isApiError(credsRes.data) || !Array.isArray(credsRes.data)) {
      throw new Error("No passkey registered");
    }
    const creds = credsRes.data as Authority[];
    const oldCred = input.oldCredentialId
      ? creds.find((c) => c.credentialId === input.oldCredentialId)
      : creds.find((c) => c.credentialId != null);
    const newCred = creds.find((c) => c.credentialId === input.newCredentialId);
    if (!oldCred?.credentialId) throw new Error("Current credential not found");
    if (!newCred?.credentialId) throw new Error("Replacement credential is not registered — register it first");
    const newKey = b64urlToBytes(newCred.publicKey);
    const adapter = await this.solana();
    const nonce = await adapter.getNonce(pid);
    const chainTime = await adapter.chainTime();
    const expiry = Math.floor(chainTime) + 300;
    const payload = await buildUpdateAuthorityPayloadV3(pidToSeed32(pid), nonce, newKey, expiry);
    const a = await this.signer().sign(payload, { allowCredentialId: oldCred.credentialId });
    const res = await this.api.post<{ signature: string; status: "confirmed" | "pending" }>("/v1/wallet/rotate", {
      oldCredentialId: oldCred.credentialId,
      newCredentialId: newCred.credentialId,
      nonce: nonce.toString(),
      expiry,
      assertion: {
        id: a.credentialId,
        signature: b64url(a.signature),
        authenticatorData: b64url(a.authenticatorData),
        clientDataJSON: b64url(a.clientDataJSON),
      },
    });
    if (!res.ok || "statusCode" in res.data) {
      const msg = (res.data as { message?: string | string[] }).message ?? "Rotation failed";
      throw new Error(Array.isArray(msg) ? msg.join(" ") : msg);
    }
    return res.data as { signature: string; status: "confirmed" | "pending" };
  }

  /** Current activation status of the smart account. */
  async activation(): Promise<ActivationView | ApiError> {
    const res = await this.api.get<ActivationView>(`/v1/account/activation`);
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
      const adapter = await this.solana();
      // Fetch recent signatures from every watched account (skip errored txs).
      const seen = new Map<string, string>(); // signature
      for (const addr of watchers) {
        const sigs = await adapter.getHistory(addr, limit).catch(() => []);
        for (const s of sigs) if (s.err === null) seen.set(s.signature, s.signature);
      }
      const signatures = [...seen.keys()].slice(0, limit);

      const cached = (await this.historyStore.get(scope)) ?? [];
      const cachedSigs = new Set(cached.map((t) => t.id));
      const fresh = signatures.filter((s) => !cachedSigs.has(s));

      newlyParsed = [];
      for (const sig of fresh.slice(0, limit)) {
        const parsed = await adapter.parseTransaction(sig).catch(() => null);
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