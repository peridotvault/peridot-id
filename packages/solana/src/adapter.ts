// Solana adapter (PRD_v4 §5.6, web3.js layering rule) — the only package that talks to @solana/web3.js
// (via the ChainRpc abstraction). Builds and submits smart-account transactions.
// Browser-safe: no Buffer / node:crypto.

import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { u64le, i64le, normalizeLowS, buildInitializePayload, buildActivatePayload, buildInitializePayloadV2, buildInitializePayloadV3, buildActivatePayloadV2, buildActivatePayloadV3, buildWithdrawPayloadV2, buildWithdrawPayloadV3, buildWithdrawTokenPayloadV2, buildWithdrawTokenPayloadV3, buildUpdateAuthorityPayloadV2, buildUpdateAuthorityPayloadV3, buildClosePayloadV2, buildClosePayloadV3 } from "@peridotvault/pid-core";
import type { Bytes } from "@peridotvault/pid-core";
import {
  pidToSeed32,
  buildAuthorizationPayload,
  buildWebAuthnMessage,
  deriveSmartAccountAddress,
  PID_PROGRAM_ID,
} from "@peridotvault/pid-core";
import {
  buildActivateInstruction,
  buildActivateInstructionV2,
  buildActivateInstructionV3,
  buildCloseInstruction,
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildExecuteInstructionV3,
  buildInitializeInstruction,
  buildInitializeInstructionV2,
  buildSecp256r1Instruction,
  buildUpdateAuthorityInstruction,
  buildWithdrawSolInstruction,
  buildWithdrawTokenInstruction,
  buildWithdrawSolInstructionV2,
  buildWithdrawTokenInstructionV2,
  buildWithdrawSolInstructionV3,
  buildWithdrawTokenInstructionV3,
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
 * Smart-account operations. The fee payer is a client-held Ed25519 keypair (fee-payer model);
 * the passkey signer is the platform WebAuthn implementation. `authorityCompressed` is the
 * registered passkey's 33-byte compressed public key (from the credential API — task 003).
 */
export class SolanaAdapter {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly programId: PublicKey = PID_PROGRAM_ID,
  ) {}

  getAddress(pid: string): PublicKey {
    return deriveSmartAccountAddress(pid, this.programId).address;
  }

  /** The current on-chain nonce (u64 LE at state offset 4) — required for the next withdrawal. */
  async getNonce(pid: string): Promise<bigint> {
    const info = await this.rpc.getAccountInfo(this.getAddress(pid));
    if (!info) return 0n;
    if (info.data.length < 12) throw new Error("smart account not initialized");
    return info.data.readBigUInt64LE(4);
  }

  /** The current on-chain authority bytes (33B compressed key at state offset 12). */
  async getAuthority(pid: string): Promise<Uint8Array> {
    const info = await this.rpc.getAccountInfo(this.getAddress(pid));
    if (!info || info.data.length < 45) throw new Error("smart account not initialized");
    return new Uint8Array(info.data.subarray(12, 45));
  }

  async isInitialized(pid: string): Promise<boolean> {
    return (await this.rpc.getAccountInfo(this.getAddress(pid))) !== null;
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

  /**
   * Initialize the smart account (V3 payload; ix layout unchanged from V2). Passkey-signed: only the new authority's key can
   * claim the PDA (no squatting). The payer funds rent and signs as fee payer.
   * Writes v2 state (112B with RP-ID hash).
   */
  async initialize(
    pid: string,
    authorityCompressed: Uint8Array,
    rpIdHash32: Uint8Array,
    payer: Keypair,
    signer: PasskeySigner,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const accountId = pidToSeed32(pid);
    const payload = await buildInitializePayloadV3(accountId, authorityCompressed, rpIdHash32);
    const assertion = await signer.sign(payload, {});
    const programIx = buildInitializeInstructionV2(
      accountId,
      authorityCompressed,
      rpIdHash32,
      payer.publicKey,
      smartAccount,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitPasskeyTx(programIx, authorityCompressed, assertion, payer);
  }

  /**
   * Activate the smart account via the relayer, V2 (disc 5). The claim is passkey-signed
   * (payload binds op-tag, account, authority, RP-ID hash, maxFee, policy, expiry) —
   * the caller supplies the client's assertion; the relayer only submits and floats
   * rent/gas. `fee` is the attested total reimbursement (`fee ≤ maxFee` enforced
   * on-chain). Returns the tx signature.
   */
  async activate(
    pid: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    rpIdHash32: Uint8Array,
    maxFeeLamports: bigint,
    feePolicyVersion: number,
    feeLamports: bigint,
    relayer: Keypair,
    treasury: PublicKey,
    expiry: number,
    assertion: PasskeyAssertion,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildActivateInstructionV2(
      pidToSeed32(pid),
      authorityCompressed,
      rpIdHash32,
      maxFeeLamports,
      feePolicyVersion,
      expiry,
      feeLamports,
      relayer.publicKey,
      smartAccount,
      treasury,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * Activate the smart account via the relayer, V3 (disc 5). The claim is passkey-signed
   * (V3 payload binds op-tag, account, authority, RP-ID hash, policy, expiry — no
   * amounts); the caller supplies the client's assertion. `networkFeeLamports` is the
   * backend-attested realtime network cost; the program recomputes `protocolFee`
   * from policy and splits relayerFee → relayer, protocolFee → revenue vault.
   */
  async activateV3(
    pid: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    rpIdHash32: Uint8Array,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    expiry: number,
    relayer: Keypair,
    treasury: PublicKey,
    assertion: PasskeyAssertion,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildActivateInstructionV3(
      pidToSeed32(pid),
      authorityCompressed,
      rpIdHash32,
      feePolicyVersion,
      expiry,
      networkFeeLamports,
      relayer.publicKey,
      smartAccount,
      treasury,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /** Balance of the smart account address (lamports). */
  async getBalanceOf(address: string | PublicKey): Promise<number> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getBalance(pub);
  }

  /** Real-time cost to activate: rent(112B v2 state) + message fee, before policy markup. */
  async estimateActivationCost(marginRate: number): Promise<{
    rentLamports: bigint;
    feeLamports: bigint;
    marginLamports: bigint;
    totalLamports: bigint;
  }> {
    const conn = this.rpc.connection;
    const pid = "dummy";
    const dummyAuthority = new Uint8Array(33);
    const dummyRpId = new Uint8Array(32);
    const smartAccount = this.getAddress(pid);
    const dummyRelayer = Keypair.generate().publicKey;
    const dummyTreasury = Keypair.generate().publicKey;
    const ix = buildActivateInstructionV2(
      pidToSeed32(pid),
      dummyAuthority,
      dummyRpId,
      0n,
      1,
      0,
      0n,
      dummyRelayer,
      smartAccount,
      dummyTreasury,
      new Uint8Array([0x7b, 0x7d]),
      this.programId,
    );
    const rawTx = new Transaction();
    rawTx.add(ix);
    rawTx.feePayer = dummyRelayer;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const msg = rawTx.compileMessage();
    const [fee, rent] = await Promise.all([
      conn.getFeeForMessage(msg, "confirmed"),
      conn.getMinimumBalanceForRentExemption(112, "confirmed"),
    ]);
    const feeLamports = BigInt(fee.value ?? 0);
    const rentLamports = BigInt(rent);
    const base = rentLamports + feeLamports;
    const margin = (base * BigInt(Math.round(marginRate * 1000))) / 1000n;
    return { rentLamports, feeLamports, marginLamports: margin, totalLamports: base + margin };
  }

  /** Top-up SOL into the smart account — a plain transfer, no program instruction (PRD_v5 §4). */
  async depositSol(pid: string, from: Keypair, lamports: bigint): Promise<string> {
    const tx = await this.buildTx(
      [buildDepositSolInstruction(from.publicKey, this.getAddress(pid), lamports)],
      from.publicKey,
    );
    return this.send(tx, [from]);
  }

  /** Top-up an SPL token — idempotent ATA creation (if missing) + plain transfer. */
  async depositToken(pid: string, mint: PublicKey, owner: Keypair, amount: bigint): Promise<string> {
    const smartAccount = this.getAddress(pid);
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
   * Sponsored SOL withdrawal, V2. The Peridot relayer signs & pays the network fee;
   * the smart account reimburses attested `feeLamports` bounded by the user-signed
   * `maxFeeLamports` (base → relayer, markup → canonical treasury). The passkey
   * assertion (V2 payload: op-tag, account, nonce/amount/destination/expiry/cap)
   * is supplied by the caller.
   */
  async sponsoredWithdrawSol(
    pid: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    amount: bigint,
    maxFeeLamports: bigint,
    feePolicyVersion: number,
    feeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildWithdrawSolInstructionV2(
      smartAccount,
      destination,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      maxFeeLamports,
      feePolicyVersion,
      feeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * Sponsored SOL withdrawal, V3. The Peridot relayer signs & pays the network fee;
   * the smart account reimburses the attested `networkFeeLamports` in full plus the
   * on-chain-recomputed `protocolFee` (relayerFee → relayer, protocolFee → revenue
   * vault). The passkey assertion (V3 payload: op-tag, account, nonce/amount/
   * destination/expiry/policy — no amounts) is supplied by the caller.
   */
  async sponsoredWithdrawSolV3(
    pid: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    amount: bigint,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildWithdrawSolInstructionV3(
      smartAccount,
      destination,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      feePolicyVersion,
      networkFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /** Sponsored SPL token withdrawal, V2 (token amount via SPL CPI, capped SOL reimbursement). */
  async sponsoredWithdrawToken(
    pid: string,
    authorityCompressed: Uint8Array,
    mint: PublicKey,
    destinationAta: PublicKey,
    amount: bigint,
    maxFeeLamports: bigint,
    feePolicyVersion: number,
    feeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstructionV2(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      maxFeeLamports,
      feePolicyVersion,
      feeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * Sponsored SPL token withdrawal, V3 (token amount via SPL CPI; attested
   * networkFee reimbursed in full plus on-chain-recomputed protocolFee).
   */
  async sponsoredWithdrawTokenV3(
    pid: string,
    authorityCompressed: Uint8Array,
    mint: PublicKey,
    destinationAta: PublicKey,
    amount: bigint,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstructionV3(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      treasury,
      relayer.publicKey,
      nonce,
      amount,
      feePolicyVersion,
      networkFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * Sponsored generic execute, V3 (disc 6). The Peridot relayer signs & pays the
   * network fee; the smart account reimburses the attested `networkFeeLamports`
   * in full plus the on-chain-recomputed `protocolFee`. The passkey assertion
   * (V3 payload: op-tag 6, account, nonce, expiry, policy, `call_hash` — no
   * amounts) is supplied by the caller; `target`/`metas`/`data` are the
   * user-authorized call the program re-verifies via `call_hash`.
   */
  async sponsoredExecuteV3(
    pid: string,
    authorityCompressed: Uint8Array,
    target: PublicKey,
    metas: { address: PublicKey; writable: boolean; signer: boolean }[],
    data: Uint8Array,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildExecuteInstructionV3(
      smartAccount,
      treasury,
      relayer.publicKey,
      nonce,
      target,
      metas,
      data,
      feePolicyVersion,
      networkFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /** True when the smart account holds `mint`'s ATA (so a token withdraw can point at it). */
  async tokenAta(pid: string, mint: PublicKey): Promise<PublicKey> {
    return getAssociatedTokenAddress(mint, this.getAddress(pid), true);
  }

  /** Rotate the smart-account authority to a new passkey public key (V3 payload). */
  async updateAuthority(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    newAuthorityCompressed: Uint8Array,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const accountId = pidToSeed32(pid);
    const nonce = await this.getNonce(pid);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildUpdateAuthorityPayloadV3(accountId, nonce, newAuthorityCompressed, expiry);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildUpdateAuthorityInstruction(smartAccount, nonce, newAuthorityCompressed, expiry, assertion.clientDataJSON, this.programId);
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /** Close the smart account, draining rent to `destination` (V3 payload, teardown only). */
  async close(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    destination: PublicKey,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const accountId = pidToSeed32(pid);
    const nonce = await this.getNonce(pid);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildClosePayloadV3(accountId, nonce, destination, expiry);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildCloseInstruction(smartAccount, destination, nonce, expiry, assertion.clientDataJSON, this.programId);
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /**
   * Submit a client-authorized rotation (V2). The caller supplies the current-key
   * assertion over `(account_id, nonce, newAuthority, expiry)`; the relayer only
   * submits and pays the network fee (no reimbursement path — rotation cost is
   * absorbed by the sponsor). Used by the credential-lifecycle rotate endpoint.
   */
  async submitRotateAuthorityTx(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    newAuthorityCompressed: Uint8Array,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    feePayer: Keypair,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid);
    const programIx = buildUpdateAuthorityInstruction(
      smartAccount,
      nonce,
      newAuthorityCompressed,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
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
    const pid = "dummy";
    const smartAccount = this.getAddress(pid);
    const dummy = Keypair.generate().publicKey;
    const ix = buildWithdrawSolInstructionV2(
      smartAccount,
      dummy,
      dummy,
      dummy,
      0n,
      0n,
      0n,
      1,
      0n,
      0,
      new Uint8Array([0x7b, 0x7d]), // tiny clientDataJSON placeholder ("{}")
      this.programId,
    );
    const rawTx = new Transaction();
    rawTx.add(ix);
    rawTx.feePayer = dummy;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const msg = rawTx.compileMessage();
    const fee = await conn.getFeeForMessage(msg, "confirmed");
    return BigInt(fee.value ?? 0);
  }

  /**
   * Network fee for a sponsored execute: `getFeeForMessage` on the exact message
   * shape (same 2-ix layout, same signer count, same meta/data lengths), so the
   * quote tracks the landed `meta.fee` 1:1. No priority fees are used anywhere
   * in this stack, so the base fee is the whole network cost.
   */
  async estimateExecuteFee(
    target: PublicKey,
    metas: { address: PublicKey; writable: boolean; signer: boolean }[],
    dataLength: number,
  ): Promise<bigint> {
    const conn = this.rpc.connection;
    const pid = "dummy";
    const smartAccount = this.getAddress(pid);
    const dummy = Keypair.generate().publicKey;
    const secpIx = buildSecp256r1Instruction(
      new Uint8Array(33).fill(2),
      new Uint8Array(64),
      new Uint8Array([0x7b, 0x7d]),
    );
    const programIx = buildExecuteInstructionV3(
      smartAccount,
      dummy,
      dummy,
      0n,
      target,
      metas.map((m) => ({
        address: m.address,
        writable: m.writable,
        // The PDA can never sign the outer tx; mirror the real layout exactly.
        signer: m.signer && m.address.toBase58() !== smartAccount.toBase58(),
      })),
      new Uint8Array(dataLength),
      1,
      0n,
      0,
      new Uint8Array([0x7b, 0x7d]), // tiny clientDataJSON placeholder ("{}")
      this.programId,
    );
    const rawTx = new Transaction();
    rawTx.add(programIx, secpIx);
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

  async getBalance(pid: string): Promise<number> {
    return this.rpc.getBalance(this.getAddress(pid));
  }

  /** SPL token balances held by an explicit smart-account address (no re-derivation). */
  async getTokenBalancesOf(address: string | PublicKey): Promise<TokenBalance[]> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getTokenAccountsByOwner(pub);
  }

  /** SPL token balances held by the smart account (raw units + decimals per mint). */
  async getTokenBalances(pid: string): Promise<TokenBalance[]> {
    return this.rpc.getTokenAccountsByOwner(this.getAddress(pid));
  }
}

export type { Bytes };