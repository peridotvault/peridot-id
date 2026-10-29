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
  buildCloseRequestPayload,
  buildCloseCancelPayload,
  deriveSmartAccountAddress,
  deriveTombstoneAddress,
  deriveTicketAddress,
  PID_PROGRAM_ID,
} from "@peridotvault/pid-core";
import {
  assertCanonicalTreasury,
  buildActivateInstruction,
  buildActivateInstructionV2,
  buildActivateInstructionV3,
  buildActivateInstructionV4,
  buildCloseInstruction,
  buildCloseRequestInstruction,
  buildCloseCancelInstruction,
  buildCloseFinalizeInstruction,
  buildDepositSolInstruction,
  buildDepositTokenInstruction,
  buildExecuteInstructionV3,
  buildExecuteInstructionV4,
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
  buildWithdrawSolInstructionV4,
  buildWithdrawTokenInstructionV4,
  deriveTreasuryPda,
} from "./instructions.js";
import type { NftItem, ParsedTx, SolanaRpc, TokenBalance } from "./rpc.js";
import { getNftsOf } from "./rpc.js";
import type { PasskeyAssertion, PasskeySigner } from "@peridotvault/pid-core";

export interface TransactionStatus {
  signature: string;
  confirmed: boolean;
  error?: string;
  computeUnits?: number;
}

const DEFAULT_EXPIRY_TTL_SECONDS = 300;

/**
 * ANT-729 (WS3): on-chain smart-account state length used as the rent basis
 * (112-byte v3 layout since ANT-866 B1: 80-byte prefix + claim-time key
 * hash, `state.rs`). Priority fees are out of scope.
 */
export const SMART_ACCOUNT_STATE_LEN = 112;
/** Solana legacy packet ceiling: composite txs above this fall back to 2 steps. */
export const TX_SIZE_LIMIT_BYTES = 1232;

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

  /**
   * Bound vault address for (pid, claiming key) — ANT-866 B1.
   * `authority` is the 33-byte compressed secp256r1 key; when omitted the
   * legacy keyless derivation is used (deprecated — those addresses no
   * longer exist on-chain; retained for indexer reference only). Every
   * transaction-building method below passes its in-scope authority, so
   * on-chain flows always resolve the bound vault.
   */
  getAddress(pid: string, authority?: Uint8Array): PublicKey {
    if (!authority) return deriveSmartAccountAddress(pid, this.programId).address;
    return deriveSmartAccountAddress(pid, authority, this.programId).address;
  }

  /**
   * ANT-635 revenue vault: the `["treasury"]` PDA bound to this adapter's
   * program id (per cluster). Fee builders and quote envelopes use this —
   * never a build const or env var.
   */
  treasuryAddress(): PublicKey {
    const [address] = deriveTreasuryPda(this.programId);
    return address;
  }

  /** Resolve the fee vault: derive when omitted, validate when explicit (migration guard). */
  private resolveTreasury(treasury?: PublicKey): PublicKey {
    if (!treasury) return this.treasuryAddress();
    assertCanonicalTreasury(treasury, this.programId);
    return treasury;
  }

  /** The current on-chain nonce (u64 LE at state offset 4) — required for the next withdrawal. */
  async getNonce(pid: string, authority?: Uint8Array): Promise<bigint> {
    const info = await this.rpc.getAccountInfo(this.getAddress(pid, authority));
    if (!info) return 0n;
    if (info.data.length < 12) throw new Error("smart account not initialized");
    return info.data.readBigUInt64LE(4);
  }

  /** Nonce read by explicit vault address (resolve paths holding the healed row — no re-derivation). */
  async getNonceOf(address: string | PublicKey): Promise<bigint> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    const info = await this.rpc.getAccountInfo(pub);
    if (!info) return 0n;
    if (info.data.length < 12) throw new Error("smart account not initialized");
    return info.data.readBigUInt64LE(4);
  }

  /** The current on-chain authority bytes (33B compressed key at state offset 12). */
  async getAuthority(pid: string, authority?: Uint8Array): Promise<Uint8Array> {
    const info = await this.rpc.getAccountInfo(this.getAddress(pid, authority));
    if (!info || info.data.length < 45) throw new Error("smart account not initialized");
    return new Uint8Array(info.data.subarray(12, 45));
  }

  /** Authority read by explicit vault address (resolve paths holding the healed row). */
  async getAuthorityOf(address: string | PublicKey): Promise<Uint8Array> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    const info = await this.rpc.getAccountInfo(pub);
    if (!info || info.data.length < 45) throw new Error("smart account not initialized");
    return new Uint8Array(info.data.subarray(12, 45));
  }

  async isInitialized(pid: string, authority?: Uint8Array): Promise<boolean> {
    return (await this.rpc.getAccountInfo(this.getAddress(pid, authority))) !== null;
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
   * Initialize the smart account (V3 payload; domain-free). Passkey-signed: only the new authority's key can
   * claim the PDA (no squatting). The payer funds rent and signs as fee payer.
   * Writes v3 state (112B, PID-key bound).
   */
  async initialize(
    pid: string,
    authorityCompressed: Uint8Array,
    payer: Keypair,
    signer: PasskeySigner,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const accountId = pidToSeed32(pid);
    const payload = await buildInitializePayloadV3(accountId, authorityCompressed);
    const assertion = await signer.sign(payload, {});
    const programIx = buildInitializeInstructionV2(
      accountId,
      authorityCompressed,
      payer.publicKey,
      smartAccount,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitPasskeyTx(programIx, authorityCompressed, assertion, payer);
  }

  /**
   * Activate the smart account via the relayer, V2 (disc 5). The claim is passkey-signed
   * (payload binds op-tag, account, authority, maxFee, policy, expiry) —
   * the caller supplies the client's assertion; the relayer only submits and floats
   * rent/gas. `fee` is the attested total reimbursement (`fee ≤ maxFee` enforced
   * on-chain). Returns the tx signature.
   */
  async activate(
    pid: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    maxFeeLamports: bigint,
    feePolicyVersion: number,
    feeLamports: bigint,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    expiry: number,
    assertion: PasskeyAssertion,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildActivateInstructionV2(
      pidToSeed32(pid),
      authorityCompressed,
      maxFeeLamports,
      feePolicyVersion,
      expiry,
      feeLamports,
      relayer.publicKey,
      smartAccount,
      vault,
      assertion.clientDataJSON,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * Activate the smart account via the relayer, V3 (disc 5). The claim is passkey-signed
   * (V3 payload binds op-tag, account, authority, policy, expiry — no
   * amounts); the caller supplies the client's assertion. `networkFeeLamports` is the
   * backend-attested realtime network cost; the program recomputes `protocolFee`
   * from policy and splits relayerFee → relayer, protocolFee → revenue vault.
   */
  async activateV3(
    pid: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    expiry: number,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    assertion: PasskeyAssertion,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildActivateInstructionV3(
      pidToSeed32(pid),
      authorityCompressed,
      feePolicyVersion,
      expiry,
      networkFeeLamports,
      relayer.publicKey,
      smartAccount,
      vault,
      assertion.clientDataJSON,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * ANT-729 (WS3): activate via the relayer, V4 (disc 14). Passkey-signed claim
   * binding op-tag, account, authority, policy, `max_total_fee`, expiry; the
   * program enforces `network_fee + protocol_fee ≤ max_total_fee`
   * (`FeeExceedsMax`) BEFORE the claim CPI, so an over-cap activation never
   * touches chain state. `initialize` (deprecated) is never used — this and
   * `activate`/`activateV3` are the only creation paths.
   */
  async activateV4(
    pid: string,
    authorityCompressed: Uint8Array<ArrayBufferLike>,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    maxTotalFeeLamports: bigint,
    expiry: number,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    assertion: PasskeyAssertion,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildActivateInstructionV4(
      pidToSeed32(pid),
      authorityCompressed,
      feePolicyVersion,
      expiry,
      networkFeeLamports,
      maxTotalFeeLamports,
      relayer.publicKey,
      smartAccount,
      vault,
      assertion.clientDataJSON,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * ANT-729 (WS3): sponsored SOL withdrawal, V4. As V3 plus the user-approved
   * `maxTotalFeeLamports` bound carried in the passkey-signed authorization
   * (spec B5). Layout MUST match `withdraw_sol_v4.rs` byte-for-byte.
   */
  async sponsoredWithdrawSolV4(
    pid: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    amount: bigint,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    maxTotalFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildWithdrawSolInstructionV4(
      smartAccount,
      destination,
      vault,
      relayer.publicKey,
      nonce,
      amount,
      feePolicyVersion,
      networkFeeLamports,
      maxTotalFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * ANT-729 (WS3): sponsored SPL token withdrawal, V4 (as V3 plus
   * `max_total_fee`; layout MUST match `withdraw_token_v4.rs`).
   */
  async sponsoredWithdrawTokenV4(
    pid: string,
    authorityCompressed: Uint8Array,
    mint: PublicKey,
    destinationAta: PublicKey,
    amount: bigint,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    maxTotalFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstructionV4(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      vault,
      relayer.publicKey,
      nonce,
      amount,
      feePolicyVersion,
      networkFeeLamports,
      maxTotalFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * ANT-729 (WS3): sponsored generic execute, V4 (as V3 plus `max_total_fee`;
   * layout MUST match `execute_v4.rs`). Same call-confinement checks as V3.
   */
  async sponsoredExecuteV4(
    pid: string,
    authorityCompressed: Uint8Array,
    target: PublicKey,
    metas: { address: PublicKey; writable: boolean; signer: boolean }[],
    data: Uint8Array,
    feePolicyVersion: number,
    networkFeeLamports: bigint,
    maxTotalFeeLamports: bigint,
    nonce: bigint,
    expiry: number,
    assertion: PasskeyAssertion,
    relayer: Keypair,
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildExecuteInstructionV4(
      smartAccount,
      vault,
      relayer.publicKey,
      nonce,
      target,
      metas,
      data,
      feePolicyVersion,
      networkFeeLamports,
      maxTotalFeeLamports,
      expiry,
      assertion.clientDataJSON,
      this.programId,
    );
    return this.submitRelayedPasskeyTx(programIx, authorityCompressed, assertion, relayer);
  }

  /**
   * ANT-729 (WS3): assemble a lazy-activation composite
   * `[activateV4_ix, secp_activate, spendV4_ix, secp_spend]` with the relayer
   * as fee payer. Each program ix is immediately followed by its secp256r1
   * precompile (the program's introspection order); the whole tx is atomic —
   * a failing spend reverts the activation, so there is no half-activated
   * state that burns fee (spec WS1 §3.2, AC-3).
   */
  private async buildCompositeTx(
    activateIx: TransactionInstruction,
    activateAuthority: Uint8Array,
    activateAssertion: PasskeyAssertion,
    spendIx: TransactionInstruction,
    spendAuthority: Uint8Array,
    spendAssertion: PasskeyAssertion,
    feePayer: PublicKey,
  ): Promise<Transaction> {
    const secpActivate = buildSecp256r1Instruction(
      activateAuthority,
      normalizeLowS(activateAssertion.signature),
      await buildWebAuthnMessage(activateAssertion.authenticatorData, activateAssertion.clientDataJSON),
    );
    const secpSpend = buildSecp256r1Instruction(
      spendAuthority,
      normalizeLowS(spendAssertion.signature),
      await buildWebAuthnMessage(spendAssertion.authenticatorData, spendAssertion.clientDataJSON),
    );
    return this.buildTx([activateIx, secpActivate, spendIx, secpSpend], feePayer);
  }

  /**
   * ANT-729 (WS3): true when a composite tx fits the legacy packet ceiling.
   * Oversize composites MUST use the automatic 2-step fallback (relayer-float
   * + claim) with identical 1-click UX — never a new user-facing step
   * (spec WS1 §3.2, AC-4).
   */
  compositeFitsLimit(tx: Transaction): boolean {
    return tx.serializeMessage().length <= TX_SIZE_LIMIT_BYTES;
  }

  /**
   * ANT-729 (WS3): realtime network fee for a composite
   * `[activate_v4 + spend]` message (`getFeeForMessage` on the exact 4-ix
   * layout). Quote estimate = rent(112B) + this fee (spec WS1 §7.1).
   */
  private async estimateCompositeMessageFee(
    activateIx: TransactionInstruction,
    spendIx: TransactionInstruction,
  ): Promise<bigint> {
    const conn = this.rpc.connection;
    const dummy = Keypair.generate().publicKey;
    const secp = buildSecp256r1Instruction(
      new Uint8Array(33).fill(2),
      new Uint8Array(64),
      new Uint8Array([0x7b, 0x7d]),
    );
    const rawTx = new Transaction();
    rawTx.add(activateIx, secp, spendIx, secp);
    rawTx.feePayer = dummy;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const fee = await conn.getFeeForMessage(rawTx.compileMessage(), "confirmed");
    return BigInt(fee.value ?? 0);
  }

  /** Dummy-data composite fee for a SOL-spend first action (quote path). */
  async estimateCompositeWithdrawFee(): Promise<bigint> {
    const pid = "dummy";
    const dummyAuthority = new Uint8Array(33);
    const smartAccount = this.getAddress(pid);
    const dummyRelayer = Keypair.generate().publicKey;
    const vault = this.treasuryAddress();
    const clientJson = new Uint8Array([0x7b, 0x7d]);
    const activateIx = buildActivateInstructionV4(
      pidToSeed32(pid), dummyAuthority, 1, 0, 0n, 0n,
      dummyRelayer, smartAccount, vault, clientJson, this.programId,
      Keypair.generate().publicKey,
    );
    const spendIx = buildWithdrawSolInstructionV4(
      smartAccount, dummyRelayer, vault, dummyRelayer,
      0n, 0n, 1, 0n, 0n, 0, clientJson, this.programId,
    );
    return this.estimateCompositeMessageFee(activateIx, spendIx);
  }

  /** Dummy-data composite fee for a generic-execute first action (quote path). */
  async estimateCompositeExecuteFee(
    target: PublicKey,
    metas: { address: PublicKey; writable: boolean; signer: boolean }[],
    dataLength: number,
  ): Promise<bigint> {
    const pid = "dummy";
    const dummyAuthority = new Uint8Array(33);
    const smartAccount = this.getAddress(pid);
    const dummyRelayer = Keypair.generate().publicKey;
    const vault = this.treasuryAddress();
    const clientJson = new Uint8Array([0x7b, 0x7d]);
    const activateIx = buildActivateInstructionV4(
      pidToSeed32(pid), dummyAuthority, 1, 0, 0n, 0n,
      dummyRelayer, smartAccount, vault, clientJson, this.programId,
      Keypair.generate().publicKey,
    );
    const spendIx = buildExecuteInstructionV4(
      smartAccount, vault, dummyRelayer, 0n, target, metas,
      new Uint8Array(dataLength), 1, 0n, 0n, 0, clientJson, this.programId,
    );
    return this.estimateCompositeMessageFee(activateIx, spendIx);
  }

  /**
   * ANT-729 (WS3): atomically activate + SOL-spend in one tx. Throws
   * `TxTooLarge` when the composite exceeds the packet ceiling so the caller
   * falls back to the automatic 2-step path (same UX, `svm-fallback-2step`).
   */
  async sponsoredActivatePlusWithdrawSolV4(
    pid: string,
    authorityCompressed: Uint8Array,
    activate: { feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; expiry: number; assertion: PasskeyAssertion },
    spend: { destination: PublicKey; amount: bigint; feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; nonce: bigint; expiry: number; assertion: PasskeyAssertion },
    relayer: Keypair,
    treasury: PublicKey | undefined,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const activateIx = buildActivateInstructionV4(
      pidToSeed32(pid), authorityCompressed,
      activate.feePolicyVersion, activate.expiry,
      activate.networkFeeLamports, activate.maxTotalFeeLamports,
      relayer.publicKey, smartAccount, vault,
      activate.assertion.clientDataJSON, this.programId,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
    );
    const spendIx = buildWithdrawSolInstructionV4(
      smartAccount, spend.destination, vault, relayer.publicKey,
      spend.nonce, spend.amount,
      spend.feePolicyVersion, spend.networkFeeLamports, spend.maxTotalFeeLamports,
      spend.expiry, spend.assertion.clientDataJSON, this.programId,
    );
    const tx = await this.buildCompositeTx(
      activateIx, authorityCompressed, activate.assertion,
      spendIx, authorityCompressed, spend.assertion,
      relayer.publicKey,
    );
    if (!this.compositeFitsLimit(tx)) throw new Error("TxTooLarge: composite exceeds packet ceiling, use 2-step fallback");
    return this.send(tx, [relayer]);
  }

  /**
   * ANT-729 (WS3): atomically activate + generic-execute in one tx.
   * Same atomicity and `TxTooLarge` fallback contract as the SOL-spend twin.
   */
  async sponsoredActivatePlusExecuteV4(
    pid: string,
    authorityCompressed: Uint8Array,
    activate: { feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; expiry: number; assertion: PasskeyAssertion },
    spend: { target: PublicKey; metas: { address: PublicKey; writable: boolean; signer: boolean }[]; data: Uint8Array; feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; nonce: bigint; expiry: number; assertion: PasskeyAssertion },
    relayer: Keypair,
    treasury: PublicKey | undefined,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const activateIx = buildActivateInstructionV4(
      pidToSeed32(pid), authorityCompressed,
      activate.feePolicyVersion, activate.expiry,
      activate.networkFeeLamports, activate.maxTotalFeeLamports,
      relayer.publicKey, smartAccount, vault,
      activate.assertion.clientDataJSON, this.programId,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
    );
    const spendIx = buildExecuteInstructionV4(
      smartAccount, vault, relayer.publicKey,
      spend.nonce, spend.target, spend.metas, spend.data,
      spend.feePolicyVersion, spend.networkFeeLamports, spend.maxTotalFeeLamports,
      spend.expiry, spend.assertion.clientDataJSON, this.programId,
    );
    const tx = await this.buildCompositeTx(
      activateIx, authorityCompressed, activate.assertion,
      spendIx, authorityCompressed, spend.assertion,
      relayer.publicKey,
    );
    if (!this.compositeFitsLimit(tx)) throw new Error("TxTooLarge: composite exceeds packet ceiling, use 2-step fallback");
    return this.send(tx, [relayer]);
  }

  /**
   * ANT-729 (WS3): atomically activate + SPL-token-spend in one tx.
   * Same atomicity and `TxTooLarge` fallback contract as the SOL twin.
   */
  async sponsoredActivatePlusWithdrawTokenV4(
    pid: string,
    authorityCompressed: Uint8Array,
    activate: { feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; expiry: number; assertion: PasskeyAssertion },
    spend: { mint: PublicKey; destinationAta: PublicKey; amount: bigint; feePolicyVersion: number; networkFeeLamports: bigint; maxTotalFeeLamports: bigint; nonce: bigint; expiry: number; assertion: PasskeyAssertion },
    relayer: Keypair,
    treasury: PublicKey | undefined,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const activateIx = buildActivateInstructionV4(
      pidToSeed32(pid), authorityCompressed,
      activate.feePolicyVersion, activate.expiry,
      activate.networkFeeLamports, activate.maxTotalFeeLamports,
      relayer.publicKey, smartAccount, vault,
      activate.assertion.clientDataJSON, this.programId,
      deriveTombstoneAddress(pidToSeed32(pid), this.programId).address,
    );
    const sourceAta = await getAssociatedTokenAddress(spend.mint, smartAccount, true);
    const spendIx = buildWithdrawTokenInstructionV4(
      smartAccount, sourceAta, spend.destinationAta, spend.mint, vault, relayer.publicKey,
      spend.nonce, spend.amount,
      spend.feePolicyVersion, spend.networkFeeLamports, spend.maxTotalFeeLamports,
      spend.expiry, spend.assertion.clientDataJSON, this.programId,
    );
    const tx = await this.buildCompositeTx(
      activateIx, authorityCompressed, activate.assertion,
      spendIx, authorityCompressed, spend.assertion,
      relayer.publicKey,
    );
    if (!this.compositeFitsLimit(tx)) throw new Error("TxTooLarge: composite exceeds packet ceiling, use 2-step fallback");
    return this.send(tx, [relayer]);
  }

  /**
   * ANT-729 (WS3): rent-exempt minimum for the 112-byte v3 state — the rent
   * leg of the lazy-activation quote (`rent(80B) + getFeeForMessage`).
   */
  async rentExemption(): Promise<bigint> {
    return BigInt(await this.rpc.connection.getMinimumBalanceForRentExemption(SMART_ACCOUNT_STATE_LEN, "confirmed"));
  }

  /** Balance of the smart account address (lamports). */
  async getBalanceOf(address: string | PublicKey): Promise<number> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getBalance(pub);
  }

  /** Real-time cost to activate: rent(v2 state) + message fee, before policy markup. */
  async estimateActivationCost(marginRate: number): Promise<{
    rentLamports: bigint;
    feeLamports: bigint;
    marginLamports: bigint;
    totalLamports: bigint;
  }> {
    const conn = this.rpc.connection;
    const pid = "dummy";
    const dummyAuthority = new Uint8Array(33);
    const smartAccount = this.getAddress(pid);
    const dummyRelayer = Keypair.generate().publicKey;
    const vault = this.treasuryAddress();
    const ix = buildActivateInstructionV2(
      pidToSeed32(pid),
      dummyAuthority,
      0n,
      1,
      0,
      0n,
      dummyRelayer,
      smartAccount,
      vault,
      new Uint8Array([0x7b, 0x7d]),
      this.programId,
      Keypair.generate().publicKey,
    );
    const rawTx = new Transaction();
    rawTx.add(ix);
    rawTx.feePayer = dummyRelayer;
    rawTx.recentBlockhash = await this.rpc.getLatestBlockhash();
    const msg = rawTx.compileMessage();
    const [fee, rent] = await Promise.all([
      conn.getFeeForMessage(msg, "confirmed"),
      conn.getMinimumBalanceForRentExemption(SMART_ACCOUNT_STATE_LEN, "confirmed"),
    ]);
    const feeLamports = BigInt(fee.value ?? 0);
    const rentLamports = BigInt(rent);
    const base = rentLamports + feeLamports;
    const margin = (base * BigInt(Math.round(marginRate * 1000))) / 1000n;
    return { rentLamports, feeLamports, marginLamports: margin, totalLamports: base + margin };
  }

  /** Top-up SOL into the smart account — a plain transfer, no program instruction (PRD_v5 §4). */
  async depositSol(pid: string, authority: Uint8Array, from: Keypair, lamports: bigint): Promise<string> {
    const tx = await this.buildTx(
      [buildDepositSolInstruction(from.publicKey, this.getAddress(pid, authority), lamports)],
      from.publicKey,
    );
    return this.send(tx, [from]);
  }

  /** Top-up an SPL token — idempotent ATA creation (if missing) + plain transfer. */
  async depositToken(pid: string, authority: Uint8Array, mint: PublicKey, owner: Keypair, amount: bigint): Promise<string> {
    const smartAccount = this.getAddress(pid, authority);
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
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildWithdrawSolInstructionV2(
      smartAccount,
      destination,
      vault,
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
   * Sponsored SOL withdrawal, V3 — DEPRECATED (ANT-800, H1).
   * Closed for new intents: the V3 authorization carries no user-approved
   * `maxTotalFee`, so an unbounded attested fee could settle. New code MUST use
   * `sponsoredWithdrawSolV4`. This method stays only to settle in-flight V3
   * signatures; backend ACTIVE paths no longer call it.
   * The Peridot relayer signs & pays the network fee;
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
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildWithdrawSolInstructionV3(
      smartAccount,
      destination,
      vault,
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
    treasury: PublicKey | undefined,
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, authorityCompressed);
    const vault = this.resolveTreasury(treasury);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstructionV2(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      vault,
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
   * Sponsored SPL token withdrawal, V3 — DEPRECATED (ANT-800, H1). Use
   * `sponsoredWithdrawTokenV4`. Stays only for in-flight V3 settlement.
   * (token amount via SPL CPI; attested
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
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const sourceAta = await getAssociatedTokenAddress(mint, smartAccount, true);
    const programIx = buildWithdrawTokenInstructionV3(
      smartAccount,
      sourceAta,
      destinationAta,
      mint,
      vault,
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
   * Sponsored generic execute, V3 (disc 6) — DEPRECATED (ANT-800, H1). Use
   * `sponsoredExecuteV4`. Stays only for in-flight V3 settlement. The Peridot relayer signs & pays the
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
    treasury: PublicKey | undefined,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const vault = this.resolveTreasury(treasury);
    const programIx = buildExecuteInstructionV3(
      smartAccount,
      vault,
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
  async tokenAta(pid: string, authority: Uint8Array, mint: PublicKey): Promise<PublicKey> {
    return getAssociatedTokenAddress(mint, this.getAddress(pid, authority), true);
  }

  /** Rotate the smart-account authority to a new passkey public key (V3 payload). */
  async updateAuthority(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    newAuthorityCompressed: Uint8Array,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? currentAuthorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const accountId = pidToSeed32(pid);
    const nonce = await this.getNonce(pid, claimAuthority);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildUpdateAuthorityPayloadV3(accountId, nonce, newAuthorityCompressed, expiry);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildUpdateAuthorityInstruction(smartAccount, nonce, newAuthorityCompressed, expiry, assertion.clientDataJSON, this.programId);
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /**
   * Open the unclaim grace window (ANT-866 B1, disc 33). Replaces immediate
   * `close` (disc 4, permanently disabled on-chain): owner-signed request to
   * `destination`, vault freezes, ticket created submitter-funded, nonce
   * consumed. Funds do NOT move here — see `cancelClose` / `finalizeClose`.
   */
  async close(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    destination: PublicKey,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? currentAuthorityCompressed;
    return this.requestClose(pid, currentAuthorityCompressed, destination, feePayer, signer, opts);
  }

  /** ANT-866 B1 `close_request` (disc 33): see `close` (kept name for caller compat). */
  async requestClose(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    destination: PublicKey,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
  ): Promise<string> {
    const smartAccount = this.getAddress(pid, currentAuthorityCompressed);
    const accountId = pidToSeed32(pid);
    const ticket = deriveTicketAddress(accountId, currentAuthorityCompressed, this.programId).address;
    const nonce = await this.getNonce(pid, currentAuthorityCompressed);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildCloseRequestPayload(accountId, nonce, destination, expiry);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildCloseRequestInstruction(
      feePayer.publicKey, smartAccount, ticket, destination, nonce, expiry, assertion.clientDataJSON, this.programId,
    );
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /** ANT-866 B1 `close_cancel` (disc 34): revive a CLOSING vault (owner-signed). */
  async cancelClose(
    pid: string,
    currentAuthorityCompressed: Uint8Array,
    feePayer: Keypair,
    signer: PasskeySigner,
    opts: { allowCredentialId?: string; expiryTtlSeconds?: number } = {},
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? currentAuthorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const accountId = pidToSeed32(pid);
    const ticket = deriveTicketAddress(accountId, claimAuthority, this.programId).address;
    const nonce = await this.getNonce(pid, claimAuthority);
    const expiry = (await this.rpc.getBlockTime()) + (opts.expiryTtlSeconds ?? DEFAULT_EXPIRY_TTL_SECONDS);

    const payload = await buildCloseCancelPayload(accountId, nonce, expiry);
    const assertion = await signer.sign(payload, { allowCredentialId: opts.allowCredentialId });
    const programIx = buildCloseCancelInstruction(
      smartAccount, ticket, nonce, expiry, assertion.clientDataJSON, this.programId,
    );
    return this.submitPasskeyTx(programIx, currentAuthorityCompressed, assertion, feePayer);
  }

  /** ANT-866 B1 `close_finalize` (disc 35): permissionless teardown after grace.
   * The caller passes the ticket destination explicitly (read it from the
   * live ticket account first); the program re-verifies equality, so a wrong
   * destination fails closed on-chain instead of redirecting funds. */
  async finalizeClose(
    pid: string,
    authorityCompressed: Uint8Array,
    destination: PublicKey,
    feePayer: Keypair,
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? authorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
    const accountId = pidToSeed32(pid);
    const ticket = deriveTicketAddress(accountId, claimAuthority, this.programId).address;
    const tombstone = deriveTombstoneAddress(accountId, this.programId).address;
    const programIx = buildCloseFinalizeInstruction(
      feePayer.publicKey, smartAccount, ticket, tombstone, destination, this.programId,
    );
    const tx = await this.buildTx([programIx], feePayer.publicKey);
    return this.send(tx, [feePayer]);
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
    derivationAuthority?: Uint8Array,
  ): Promise<string> {
    const claimAuthority = derivationAuthority ?? currentAuthorityCompressed;
    const smartAccount = this.getAddress(pid, claimAuthority);
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
    const vault = this.treasuryAddress();
    const ix = buildWithdrawSolInstructionV2(
      smartAccount,
      dummy,
      vault,
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
    const vault = this.treasuryAddress();
    const programIx = buildExecuteInstructionV3(
      smartAccount,
      vault,
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

  async getBalance(pid: string, authority?: Uint8Array): Promise<number> {
    return this.rpc.getBalance(this.getAddress(pid, authority));
  }

  /** SPL token balances held by an explicit smart-account address (no re-derivation). */
  async getTokenBalancesOf(address: string | PublicKey): Promise<TokenBalance[]> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return this.rpc.getTokenAccountsByOwner(pub);
  }

  /** SPL token balances held by the smart account (raw units + decimals per mint). */
  async getTokenBalances(pid: string, authority?: Uint8Array): Promise<TokenBalance[]> {
    return this.rpc.getTokenAccountsByOwner(this.getAddress(pid, authority));
  }

  /** Heuristic NFT inventory (SPL 0-decimal ×1; misses Token-2022/cNFTs — no DAS). */
  async getNftsOf(address: string | PublicKey): Promise<NftItem[]> {
    const pub = typeof address === "string" ? new PublicKey(address) : address;
    return getNftsOf(this.rpc, pub);
  }
}

export type { Bytes };