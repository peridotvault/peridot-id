// Peridot wallet client (task 009) — the PRD_v5 §9 surface over the Solana adapter.

import { PublicKey } from "@solana/web3.js";
import { b64urlToBytes, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import type { Account, ActivityRecord, ApiError, Authority, WalletTransaction } from "@peridotvault/pid-types";
import type { PasskeySigner, TokenBalance, TransactionStatus } from "@peridotvault/pid-solana";
import { BrowserPasskeySigner } from "./passkey";
import { FeePayerManager, type SecretStore } from "./fee-payer";

export interface PeridotWalletOptions {
  solanaRpcUrl: string | string[];
  feePayerStore?: SecretStore;
  passkeySigner?: PasskeySigner;
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

  constructor(
    private readonly api: ApiLike,
    options: PeridotWalletOptions,
  ) {
    this.adapter = new SolanaAdapter(new SolanaRpc(options.solanaRpcUrl));
    this.feePayer = new FeePayerManager(options.feePayerStore);
    this.passkeySigner = options.passkeySigner ?? new BrowserPasskeySigner();
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
    await this.recordActivity({
      type: "DEPOSIT",
      amount: input.amount,
      asset: input.asset === "SOL" ? "SOL" : input.asset,
      direction: "in",
      txHash: signature,
    });
    return { signature };
  }

  /** Passkey-authorized withdrawal. */
  async withdraw(input: WithdrawInput): Promise<{ signature: string }> {
    const accountId = await this.defaultAccountId();
    const feePayer = await this.feePayer.getOrCreate();
    const authority = await this.authorityCompressed();
    const lamports = BigInt(input.amount);

    const signature =
      input.asset === "SOL"
        ? await this.adapter.withdrawSol(accountId, authority, new PublicKey(input.to), lamports, feePayer, this.passkeySigner)
        : await this.adapter.withdrawToken(accountId, authority, new PublicKey(input.asset), new PublicKey(input.to), lamports, feePayer, this.passkeySigner);
    await this.recordActivity({
      type: "WITHDRAW",
      amount: input.amount,
      asset: input.asset === "SOL" ? "SOL" : input.asset,
      direction: "out",
      counterparty: input.to,
      txHash: signature,
    });
    return { signature };
  }

  /** Best-effort activity-history record — never fail the wallet op on a logging miss. */
  private async recordActivity(input: ActivityRecord): Promise<void> {
    try {
      await this.api.post("/v1/wallet/transactions", input);
    } catch {
      // activity record is best-effort; the on-chain operation already succeeded.
    }
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return this.adapter.getStatus(signature);
  }

  async getBalance(): Promise<number> {
    return this.adapter.getBalanceOf(await this.smartAccountAddress());
  }

  /** SPL token balances held by the smart account. */
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

  /** Activity history, newest first. */
  async transactions(): Promise<WalletTransaction[] | ApiError> {
    const res = await this.api.get<WalletTransaction[]>("/v1/wallet/transactions");
    return res.data;
  }

  async transaction(id: string): Promise<WalletTransaction | ApiError> {
    const res = await this.api.get<WalletTransaction>(`/v1/wallet/transactions/${id}`);
    return res.data;
  }
}