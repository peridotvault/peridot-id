// Solana adapter (PRD_v4 §5.6, ADR 007 §8) — the only package that talks to @solana/web3.js
// (via the ChainRpc abstraction). Builds and submits smart-account transactions.
// Browser-safe: no Buffer / node:crypto.

import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { u64le, i64le, normalizeLowS } from "./bytes";
import type { Bytes } from "./bytes";
import {
  accountIdToSeed32,
  buildAuthorizationPayload,
  buildWebAuthnMessage,
  deriveSmartAccountAddress,
  PERIDOT_PROGRAM_ID,
} from "./core";
import {
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildInitializeInstruction,
  buildSecp256r1Instruction,
  buildUpdateAuthorityInstruction,
  buildWithdrawSolInstruction,
  buildWithdrawTokenInstruction,
} from "./instructions";
import type { SolanaRpc } from "./rpc";

/** A WebAuthn assertion as produced by a passkey. */
export interface PasskeyAssertion {
  credentialId: string;
  /** Raw ECDSA r‖s (64 bytes) from the assertion. */
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}

/** Platform-specific passkey signer (WebAuthn in the browser/Expo; injected here). */
export interface PasskeySigner {
  /** Sign the given challenge (the authorization payload hash) with an existing passkey. */
  sign(challenge: Uint8Array, opts?: { allowCredentialId?: string }): Promise<PasskeyAssertion>;
}

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
    private readonly programId: PublicKey = PERIDOT_PROGRAM_ID,
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

  /** Passkey-authorized SOL withdrawal. */
  async withdrawSol(
    accountId: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    amount: bigint,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const nonce = await this.getNonce(accountId);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildAuthorizationPayload([u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry)]);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildWithdrawSolInstruction(smartAccount, destination, nonce, amount, expiry, assertion.clientDataJSON);
    return this.submitPasskeyTx(programIx, authorityCompressed, assertion, feePayer);
  }

  /** Passkey-authorized SPL token withdrawal. */
  async withdrawToken(
    accountId: string,
    authorityCompressed: Uint8Array,
    mint: PublicKey,
    destinationAta: PublicKey,
    amount: bigint,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(accountId);
    const nonce = await this.getNonce(accountId);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);

    const payload = await buildAuthorizationPayload([u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry)]);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildWithdrawTokenInstruction(smartAccount, sourceAta, destinationAta, mint, nonce, amount, expiry, assertion.clientDataJSON);
    return this.submitPasskeyTx(programIx, authorityCompressed, assertion, feePayer);
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

  async getBalance(accountId: string): Promise<number> {
    return this.rpc.getBalance(this.getAddress(accountId));
  }
}

export type { Bytes };