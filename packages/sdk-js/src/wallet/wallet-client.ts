// Peridot wallet client (task 009) — the PRD_v5 §9 surface over the Solana adapter.

import { PublicKey } from "@solana/web3.js";
import { b64urlToBytes, SolanaAdapter, SolanaRpc } from "@antigane/solana";
import type { Account, ApiError, Authority } from "@antigane/types";
import type { TransactionStatus } from "@antigane/solana";
import { BrowserPasskeySigner } from "./passkey";
import type { PasskeySigner } from "@antigane/solana";
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
    if (!account) throw new Error("Akun tidak ditemukan — buat akun terlebih dahulu");
    return account.id;
  }

  private async authorityCompressed(): Promise<Uint8Array> {
    const res = await this.api.get<Authority[]>("/v1/credentials");
    const auth = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!auth) throw new Error("Tidak ada passkey terdaftar");
    return b64urlToBytes(auth.publicKey);
  }

  /** The default account (with the deterministic smart-account address). */
  async me(): Promise<Account | ApiError> {
    const res = await this.api.get<Account[]>("/v1/accounts");
    if (isApiError(res.data)) return res.data;
    const account = (res.data ?? [])[0];
    if (!account) return { statusCode: 404, message: "Akun tidak ditemukan" };
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
    return { signature };
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return this.adapter.getStatus(signature);
  }

  async getBalance(): Promise<number> {
    return this.adapter.getBalance(await this.defaultAccountId());
  }
}