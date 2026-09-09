// Solana adapter (PRD_v4 §5.6, ADR 007 §8) — the only package that talks to @solana/web3.js
// (via the ChainRpc abstraction). Builds and submits smart-account transactions.
// Browser-safe: no Buffer / node:crypto.

import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { u64le, i64le, normalizeLowS } from "@peridotvault/pid-core";
import type { Bytes } from "@peridotvault/pid-core";
import {
  accountIdToSeed32,
  buildAuthorizationPayload,
  buildWebAuthnMessage,
  deriveSmartAccountAddress,
  PID_PROGRAM_ID,
} from "@peridotvault/pid-core";
import {
  buildActivateInstruction,
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildInitializeInstruction,
  buildSecp256r1Instruction,
  buildUpdateAuthorityInstruction,
  buildWithdrawSolInstruction,
  buildWithdrawTokenInstruction,
} from "./instructions";
import type { ParsedTx, SolanaRpc, TokenBalance } from "./rpc";
import type { PasskeyAssertion, PasskeySigner } from "@peridotvault/pid-core";

export interface TransactionStatus {
  signature: string;
  confirmed: boolean;
  error?: string;
  computeUnits?: number;
}

const DEFAULT_EXPIRY_TTL_SECONDS = 300;

/**
 * Smart-account operations. The fee payer is a client-held Ed25519 keypair (ADR 006 §2);
 * the passkey signer is the platform WebAuthn implementation. `authorityCompressed` is the
 * registered passkey's 33-byte compressed public key (from the credential API — task 003).
 */
export class SolanaAdapter {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly programId: PublicKey = PID_PROGRAM_ID,
  ) {}

  getAddress(accountId: string): PublicKey {
    return deriveSmartAccountAddress(accountId, this.programId).address;
  }

  /** The current on-chain nonce (u64 LE at state offset 4) — required for the next withdrawal. */
  async getNonce(accountId: string): Promise<bigint> {
    const info = await this.rpc.getAccountInfo(this.getAddress(accountId));
    if (!info) return 0n;
    if (info.data.length < 12) throw new Error("smart account not initialized");
    return info.data.readBigUInt64LE(4);
  }

  async isInitialized(accountId: string): Promise<boolean> {
    return (await this.rpc.getAccountInfo(this.getAddress(accountId))) !== null;
  }

  /** True when the smart-account PDA is actually owned by our program (i.e. activated). */
  async isActivated(address: string | PublicKey): Promise<boolean> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    const info = await this.rpc.getAccountInfo(pub);
    if (!info || info.data.length === 0) return false;
    return info.owner.toBase58() === this.programId.toBase58();
  }

  /** Whether an account currently exists on-chain. */
  async hasAccount(address: string | PublicKey): Promise<boolean> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return (await this.rpc.getAccountInfo(pub)) !== null;
  }

  private async buildTx(instructions: TransactionInstruction[], feePayer: PublicKey): Promise<Transaction> {
    const tx = new Transaction();
    for (const ix of instructions) tx.add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = await this.rpc.getLatestBlockhash();
    return tx;
  }

  /** Initialize the smart account with the passkey's compressed pubkey as authority. */
  async initialize(accountId: string, authorityCompressed: Uint8Array, payer: Keypair): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const tx = await this.buildTx(
      [buildInitializeInstruction(accountIdToSeed32(accountId), authorityCompressed, payer.publicKey, smartAccount)],
      payer.publicKey,
    );
    return this.send(tx, [payer]);
  }

  /** Activate the smart account via the relayer (disc 5). Returns the tx signature. */
  async activate(
    accountId: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    activationFeeLamports: bigint,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const tx = await this.buildTx(
      [
        buildActivateInstruction(
          accountIdToSeed32(accountId),
          authorityCompressed,
          activationFeeLamports,
          relayer.publicKey,
          smartAccount,
          treasury,
        ),
      ],
      relayer.publicKey,
    );
    return this.send(tx, [relayer]);
  }

  /** Balance of the smart account address (lamports). */
  async getBalanceOf(address: string | PublicKey): Promise<number> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getBalance(pub);
  }

  /** Real-time cost to activate: rent(80B) + message fee + margin (rate on rent+fee). */
  async estimateActivationCost(marginRate: number): Promise<{
    rentLamports: bigint;
    feeLamports: bigint;
    marginLamports: bigint;
    totalLamports: bigint;
  }> {
    const conn = this.rpc.connection;
    const accountId = "00000000000000000000000000000000";
    const dummyAuthority = new Uint8Array(33);
    const smartAccount = this.getAddress(accountId);
    const dummyRelayer = Keypair.generate().publicKey;
    const dummyTreasury = Keypair.generate().publicKey;
    const ix = buildActivateInstruction(
      accountIdToSeed32(accountId),
      dummyAuthority,
      0n,
      dummyRelayer,
      smartAccount,
      dummyTreasury,
    );
    const rawTx = new Transaction();
    rawTx.add(ix);
    rawTx.feePayer = dummyRelayer;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const msg = rawTx.compileMessage();
    const [fee, rent] = await Promise.all([
      conn.getFeeForMessage(msg, "confirmed"),
      conn.getMinimumBalanceForRentExemption(80, "confirmed"),
    ]);
    const feeLamports = BigInt(fee.value ?? 0);
    const rentLamports = BigInt(rent);
    const base = rentLamports + feeLamports;
    const margin = (base * BigInt(Math.round(marginRate * 1000))) / 1000n;
    return { rentLamports, feeLamports, marginLamports: margin, totalLamports: base + margin };
  }

  /** Top-up SOL into the smart account — a plain transfer, no program instruction (PRD_v5 §4). */
  async depositSol(accountId: string, from: Keypair, lamports: bigint): Promise<string> {
    const tx = await this.buildTx(
      [buildDepositSolInstruction(from.publicKey, this.getAddress(accountId), lamports)],
      from.publicKey,
    );
    return this.send(tx, [from]);
  }

  /**
   * First top-up (wallet activation, PRD_v5 §3): initialize the smart account AND deposit
   * in a single transaction. Idempotent — if already initialized, just deposits.
   */
  async initializeAndDepositSol(
    accountId: string,
    authorityCompressed: Uint8Array,
    from: Keypair,
    lamports: bigint,
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const ixs: TransactionInstruction[] = [];
    if (!(await this.isInitialized(accountId))) {
      ixs.push(buildInitializeInstruction(accountIdToSeed32(accountId), authorityCompressed, from.publicKey, smartAccount));
    }
    ixs.push(buildDepositSolInstruction(from.publicKey, smartAccount, lamports));
    const tx = await this.buildTx(ixs, from.publicKey);
    return this.send(tx, [from]);
  }

  /** Top-up an SPL token — idempotent ATA creation (if missing) + plain transfer. */
  async depositToken(accountId: string, mint: PublicKey, owner: Keypair, amount: bigint): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const fromAta = await getAssociatedTokenAddress(mint, owner.publicKey);
    const ata = await getAssociatedTokenAddress(mint, smartAccount, true);
    const ixs: TransactionInstruction[] = [];
    if ((await this.rpc.getAccountInfo(ata)) === null) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, smartAccount, mint));
    }
    ixs.push(createTransferInstruction(fromAta, ata, owner.publicKey, Number(amount)));
    const tx = await this.buildTx(ixs, owner.publicKey);
    return this.send(tx, [owner]);
  }

  /**
   * Sponsored SOL withdrawal. The Peridot relayer signs & pays the network fee; the smart
   * account reimburses `relayFeeLamports` to the treasury. The passkey assertion (signed
   * against nonce/amount/destination/expiry/relayFee) is supplied by the caller.
   */
  async sponsoredWithdrawSol(
    accountId: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    amount: bigint,
    relayFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const programIx = buildWithdrawSolInstruction(
      smartAccount,
      destination,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      relayFeeLamports,
      expiry,
      assertion.clientDataJSON,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /** Sponsored SPL token withdrawal (token amount via SPL CPI, relay fee reimbursed as SOL). */
  async sponsoredWithdrawToken(
    accountId: string,
    authorityCompressed: Uint8Array,
    mint: PublicKey,
    destinationAta: PublicKey,
    amount: bigint,
    relayFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstruction(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      relayFeeLamports,
      expiry,
      assertion.clientDataJSON,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /** True when the smart account holds `mint`'s ATA (so a token withdraw can point at it). */
  async tokenAta(accountId: string, mint: PublicKey): Promise<PublicKey> {
    return getAssociatedTokenAddress(mint, this.getAddress(accountId), true);
  }

  /** Rotate the smart-account authority to a new passkey public key. */
  async updateAuthority(
    accountId: string,
    currentAuthorityCompressed: Uint8Array,
    newAuthorityCompressed: Uint8Array,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const nonce = await this.getNonce(accountId);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildAuthorizationPayload([u64le(nonce), newAuthorityCompressed, i64le(expiry)]);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildUpdateAuthorityInstruction(smartAccount, nonce, newAuthorityCompressed, expiry, assertion.clientDataJSON);
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /** Assemble program-ix-first / secp256r1-precompile-ix-second and submit (introspection order). */
  private async submitPasskeyTx(
    programIx: TransactionInstruction,
    authorityCompressed: Uint8Array,
    assertion: PasskeyAssertion,
    feePayer: Keypair,
  ): Promise<string> {
    const secpIx = buildSecp256r1Instruction(
      authorityCompressed,
      normalizeLowS(assertion.signature),
      await buildWebAuthnMessage(assertion.authenticatorData, assertion.clientDataJSON),
    );
    const tx = await this.buildTx([programIx, secpIx], feePayer.publicKey);
    return this.send(tx, [feePayer]);
  }

  /** Same assembly as submitPasskeyTx but the Peridot relayer is the tx signer/fee payer. */
  private async submitRelayedPasskeyTx(
    programIx: TransactionInstruction,
    authorityCompressed: Uint8Array,
    assertion: PasskeyAssertion,
    relayer: Keypair,
  ): Promise<string> {
    const secpIx = buildSecp256r1Instruction(
      authorityCompressed,
      normalizeLowS(assertion.signature),
      await buildWebAuthnMessage(assertion.authenticatorData, assertion.clientDataJSON),
    );
    const tx = await this.buildTx([programIx, secpIx], relayer.publicKey);
    return this.send(tx, [relayer]);
  }

  /** Chain block time (seconds) — used for passkey authorization expiries. */
  async chainTime(): Promise<number> {
    return this.rpc.getBlockTime();
  }

  /** Network fee for a sponsored withdraw (1 signature, relayer as fee payer) — the base the
   *  margin is applied to. Mirrors estimateActivationCost's message-fee approach. */
  async estimateWithdrawFee(): Promise<bigint> {
    const conn = this.rpc.connection;
    const accountId = "00000000000000000000000000000000";
    const smartAccount = this.getAddress(accountId);
    const dummy = Keypair.generate().publicKey;
    const ix = buildWithdrawSolInstruction(
      smartAccount,
      dummy,
      dummy,
      dummy,
      0n,
      0n,
      0n,
      0,
      new Uint8Array([0x7b, 0x7d]), // tiny clientDataJSON placeholder ("{}")
    );
    const rawTx = new Transaction();
    rawTx.add(ix);
    rawTx.feePayer = dummy;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const msg = rawTx.compileMessage();
    const fee = await conn.getFeeForMessage(msg, "confirmed");
    return BigInt(fee.value ?? 0);
  }

  async send(tx: Transaction, signers: Keypair[]): Promise<string> {
    return this.rpc.sendTransaction(tx, signers);
  }

  async getStatus(signature: string): Promise<TransactionStatus> {
    const meta = await this.rpc.getTransaction(signature);
    if (!meta) return { signature, confirmed: false };
    return {
      signature,
      confirmed: meta.err === null,
      error: meta.err ? JSON.stringify(meta.err) : undefined,
      computeUnits: meta.computeUnitsConsumed,
    };
  }

  /** Confirm a signature for a few attempts; resolves "confirmed" | "failed" | "pending". */
  async waitForConfirmation(signature: string, attempts = 8, intervalMs = 1000): Promise<"confirmed" | "failed" | "pending"> {
    for (let i = 0; i < attempts; i++) {
      const status = await this.getStatus(signature).catch(() => null);
      if (status?.confirmed) return status.error ? "failed" : "confirmed";
      if (status && status.error) return "failed";
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return "pending";
  }

  /** Recent confirmed transactions touching an address (newest first). */
  async getHistory(address: string, limit = 30): Promise<{ signature: string; err: unknown }[]> {
    return this.rpc.getSignaturesForAddress(new PublicKey(address), limit);
  }

  /** Full parsed metadata for a transaction. */
  async parseTransaction(signature: string): Promise<ParsedTx | null> {
    return this.rpc.getParsedTransaction(signature);
  }

  async getBalance(accountId: string): Promise<number> {
    return this.rpc.getBalance(this.getAddress(accountId));
  }

  /** SPL token balances held by an explicit smart-account address (no re-derivation). */
  async getTokenBalancesOf(address: string | PublicKey): Promise<TokenBalance[]> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getTokenAccountsByOwner(pub);
  }

  /** SPL token balances held by the smart account (raw units + decimals per mint). */
  async getTokenBalances(accountId: string): Promise<TokenBalance[]> {
    return this.rpc.getTokenAccountsByOwner(this.getAddress(accountId));
  }
}

export type { Bytes };