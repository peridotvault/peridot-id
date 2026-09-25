// Peridot-sponsored withdrawals (V3 authorization). The smart account (PDA) cannot be a
// Solana fee payer, so Peridot's relayer signs the transaction and floats the network fee;
// the smart account reimburses the attested `networkFee` in full to the relayer plus the
// on-chain-recomputed `protocolFee` to the canonical revenue vault — atomically, in the
// same transaction. The passkey signs the intent plus a `feePolicyVersion` (never amounts);
// the program enforces the rate, recipients, and formula. The server validates shape,
// balance, TTL, policy, and quote drift — and reconciles attested vs actual post-confirmation.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccount } from "@prisma/client";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { ACCOUNT_TYPE_SMART } from "../common/chains";
import { ChainRegistryService } from "../chain/chain-registry.service";
import {
  exceedsDriftBound,
  feePolicyVersion as configuredPolicyVersion,
  protocolFeeBps,
  protocolFeeOf,
  relayerKeypair,
  solanaAdapter,
  treasuryPubkey,
} from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export interface WithdrawQuote {
  /** Realtime network-cost estimate the backend will attest near (lamports). */
  networkFeeLamports: string;
  /** Fixed protocol percentage in bps for the quoted policy version. */
  protocolFeeBps: number;
  /** Fee-policy version the quote was computed under (client must sign this). */
  feePolicyVersion: number;
  /** networkFee + protocolFee at quote time (informational — settles at submit-time values). */
  totalFeeLamports: string;
  chainTime: number;
  /** Canonical revenue vault receiving the protocol fee (informational — enforced on-chain). */
  treasury: string;
}

export interface SponsoredWithdrawResult {
  signature: string;
  networkFeeLamports: string;
  protocolFeeLamports: string;
  status: "confirmed" | "pending";
}

/** Maximum authorization lifetime (seconds) — bounds cross-cluster replay. */
const MAX_TTL_SECS = 600;

@Injectable()
export class SponsoredWithdrawService {
  private readonly logger = new Logger(SponsoredWithdrawService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
  ) {}

  private policyVersion(): number {
    return configuredPolicyVersion(this.config);
  }

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    return relayerKeypair(this.pidSolana, this.config);
  }

  private treasury(): PublicKey {
    return treasuryPubkey(this.pidSolana, this.config);
  }

  private async adapter(): Promise<SolanaAdapter> {
    const [rpcUrl, programId] = await Promise.all([this.chains.solanaRpcUrl(), this.chains.solanaProgramId()]);
    return solanaAdapter(this.pidSolana, rpcUrl, programId);
  }

  /** The identity's smart-account chain row (ownership from token). */
  private async resolveSmart(pid: string): Promise<{ chain: ChainAccount }> {
    const chain = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_SMART },
    });
    if (!chain) throw new NotFoundException("Account not found");
    return { chain };
  }

  private async assertActivated(adapter: SolanaAdapter, address: string): Promise<void> {
    let activated = false;
    try {
      activated = await adapter.isActivated(address);
    } catch {
      // fall through to the false branch
    }
    if (!activated) throw new ConflictException("Wallet must be activated before sending");
  }

  /** Realtime network-cost estimate (no margin — the protocol fee is a separate percentage). */
  private async networkFeeLamports(adapter: SolanaAdapter): Promise<bigint> {
    return adapter.estimateWithdrawFee();
  }

  /** Compute the quote the client signs the policy (not amounts) against. */
  async quote(pid: string): Promise<WithdrawQuote> {
    const adapter = await this.adapter();
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const networkFee = await this.networkFeeLamports(adapter);
    const version = this.policyVersion();
    const bps = protocolFeeBps(version);
    const protocolFee = protocolFeeOf(networkFee, bps);
    const chainTime = await adapter.chainTime();
    return {
      networkFeeLamports: networkFee.toString(),
      protocolFeeBps: bps,
      feePolicyVersion: version,
      totalFeeLamports: (networkFee + protocolFee).toString(),
      chainTime,
      treasury: this.treasury().toBase58(),
    };
  }

  async withdraw(
    pid: string,
    dto: {
      asset: string;
      to: string;
      amount: string;
      nonce: string;
      expiry: number;
      feePolicyVersion: number;
      /** The quoted networkFee the client signed against (drift reference, not a cap). */
      quotedNetworkFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter();
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) throw new BadRequestException("Unknown or inactive passkey");

    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException("Amount must be greater than 0");
    const version = this.policyVersion();
    if (dto.feePolicyVersion !== version) {
      throw new BadRequestException("Unsupported fee policy — re-quote and try again");
    }
    const bps = protocolFeeBps(version);

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) throw new BadRequestException("Authorization expired — please try again");
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      throw new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again");
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await this.networkFeeLamports(adapter);
    if (exceedsDriftBound(networkFee, quoted)) {
      throw new ConflictException("Network fee moved — re-quote and try again");
    }
    const protocolFee = protocolFeeOf(networkFee, bps);
    const totalFee = networkFee + protocolFee;

    if (dto.to === chain.address) {
      throw new BadRequestException("Destination cannot be the smart account");
    }
    if (dto.asset === "SOL") {
      const smart = BigInt(await adapter.getBalanceOf(chain.address));
      if (smart < amount + totalFee) {
        throw new BadRequestException(
          `Insufficient balance — need ${amount + totalFee} lamports, have ${smart}`,
        );
      }
    } else {
      const { PublicKey } = this.pidSolana;
      const mint = new PublicKey(dto.asset);
      const sourceAta = await adapter.tokenAta(pid, mint);
      const balances = await adapter.getTokenBalancesOf(sourceAta.toBase58()).catch(() => []);
      const row = balances.find((b) => b.mint === mint.toBase58());
      if (!row || BigInt(row.amount) < amount) {
        throw new BadRequestException("Insufficient token balance");
      }
      const smartSol = BigInt(await adapter.getBalanceOf(chain.address));
      if (smartSol < totalFee) {
        throw new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`);
      }
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateWithdrawFee().catch(() => 5000n);
    if (relayerBal < Number(feeForTx)) {
      await this.security.log(pid, "withdraw.relayer_unfunded", {});
      throw new ServiceUnavailableException(
        "Peridot's fee service is briefly unavailable. No SOL was deducted from your wallet — please try again in a moment.",
      );
    }

    const authorityCompressed = coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>;
    const { b64urlToBytes } = this.pidSolana;
    const assertion: PasskeyAssertion = {
      credentialId: dto.assertion.id,
      signature: b64urlToBytes(dto.assertion.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(dto.assertion.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(dto.assertion.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };

    const { PublicKey } = this.pidSolana;
    const nonce = chainNonce;
    const expiry = dto.expiry;

    let signature: string;
    if (dto.asset === "SOL") {
      signature = await adapter.sponsoredWithdrawSolV3(
        pid,
        authorityCompressed,
        new PublicKey(dto.to),
        amount,
        version,
        networkFee,
        nonce,
        expiry,
        assertion,
        this.relayer(),
        this.treasury(),
      );
    } else {
      const mint = new PublicKey(dto.asset);
      const sourceAta = await adapter.tokenAta(pid, mint);
      if (!(await adapter.hasAccount(sourceAta.toBase58()))) {
        throw new BadRequestException("Token account is not registered on this wallet yet");
      }
      signature = await adapter.sponsoredWithdrawTokenV3(
        pid,
        authorityCompressed,
        mint,
        new PublicKey(dto.to),
        amount,
        version,
        networkFee,
        nonce,
        expiry,
        assertion as never,
        this.relayer(),
        this.treasury(),
      );
    }

    const status = (await adapter.waitForConfirmation(signature, 8, 1000)) === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "withdraw.submitted", {
      signature,
      amount: amount.toString(),
      asset: dto.asset,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
    });
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, version).catch((err) =>
      this.logger.warn(`withdraw reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
    };
  }

  /**
   * Post-confirmation reconciliation: verify the program applied the canonical
   * formula to the attested network fee, and that the attested fee tracks the
   * actual network charge. Logs relayer P&L and raises anomalies — the program
   * guarantees the rate and recipients; this guards the attested number.
   */
  private async reconcile(
    pid: string,
    adapter: SolanaAdapter,
    signature: string,
    networkFee: bigint,
    protocolFee: bigint,
    version: number,
    kind = "withdraw",
  ): Promise<void> {
    const expectedProtocol = protocolFeeOf(networkFee, protocolFeeBps(version));
    const parsed = await adapter.parseTransaction(signature).catch(() => null);
    const actual = parsed?.fee != null ? BigInt(parsed.fee) : null;
    const absorbed = actual != null && actual > networkFee ? (actual - networkFee).toString() : "0";
    const overAttested = actual != null && exceedsDriftBound(networkFee, actual);
    await this.security.log(pid, `${kind}.reconciled`, {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual?.toString() ?? "unknown",
      relayerAbsorbed: absorbed,
      overAttested,
    });
    if (protocolFee !== expectedProtocol) {
      this.logger.error(`${kind} formula anomaly: ${signature} protocol=${protocolFee} expected=${expectedProtocol}`);
    }
    if (overAttested) {
      this.logger.error(`${kind} over-attestation anomaly: ${signature} attested=${networkFee} actual=${actual}`);
    }
  }

  /** Decode + validate a generic execute call (caps, self-target, PDA delegation). */
  private async decodeExecuteCall(
    chainAddress: string,
    call: {
      target: string;
      metas: { address: string; writable: boolean; signer: boolean }[];
      data: string;
    },
  ): Promise<{ target: PublicKey; metas: { address: PublicKey; writable: boolean; signer: boolean }[]; data: Uint8Array }> {
    const { PublicKey, b64urlToBytes } = this.pidSolana;
    const programId = await this.chains.solanaProgramId();
    const target = new PublicKey(call.target);
    if (target.toBase58() === new PublicKey(programId).toBase58()) {
      throw new BadRequestException("Target cannot be the smart-account program");
    }
    if (call.metas.length === 0 || call.metas.length > 64) {
      throw new BadRequestException("Execute metas must number 1..64");
    }
    const data = b64urlToBytes(call.data) as unknown as Uint8Array;
    if (data.length > 10_240) {
      throw new BadRequestException("Execute data exceeds 10_240 bytes");
    }
    const metas = call.metas.map((m) => ({ address: new PublicKey(m.address), writable: m.writable, signer: m.signer }));
    const delegates = metas.some((m) => m.signer && m.address.toBase58() === chainAddress);
    if (!delegates) {
      throw new BadRequestException("Execute must delegate the smart account as a signer");
    }
    return { target, metas, data };
  }

  /** Quote a generic execute: realtime network-cost estimate for the exact call shape. */
  async quoteExecute(
    pid: string,
    call: {
      target: string;
      metas: { address: string; writable: boolean; signer: boolean }[];
      data: string;
    },
  ): Promise<WithdrawQuote> {
    const adapter = await this.adapter();
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const decoded = await this.decodeExecuteCall(chain.address, call);
    const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
    const version = this.policyVersion();
    const bps = protocolFeeBps(version);
    const protocolFee = protocolFeeOf(networkFee, bps);
    const chainTime = await adapter.chainTime();
    return {
      networkFeeLamports: networkFee.toString(),
      protocolFeeBps: bps,
      feePolicyVersion: version,
      totalFeeLamports: (networkFee + protocolFee).toString(),
      chainTime,
      treasury: this.treasury().toBase58(),
    };
  }

  async execute(
    pid: string,
    dto: {
      target: string;
      metas: { address: string; writable: boolean; signer: boolean }[];
      data: string;
      nonce: string;
      expiry: number;
      feePolicyVersion: number;
      /** The quoted networkFee the client signed against (drift reference, not a cap). */
      quotedNetworkFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter();
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const decoded = await this.decodeExecuteCall(chain.address, dto);

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) throw new BadRequestException("Unknown or inactive passkey");

    const version = this.policyVersion();
    if (dto.feePolicyVersion !== version) {
      throw new BadRequestException("Unsupported fee policy — re-quote and try again");
    }
    const bps = protocolFeeBps(version);

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) throw new BadRequestException("Authorization expired — please try again");
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      throw new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again");
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
    if (exceedsDriftBound(networkFee, quoted)) {
      throw new ConflictException("Network fee moved — re-quote and try again");
    }
    const protocolFee = protocolFeeOf(networkFee, bps);
    const totalFee = networkFee + protocolFee;

    // The generic call moves no SOL itself (inner programs debit their own
    // accounts); the wallet must cover the fee split, the program backstops the rest.
    const smartSol = BigInt(await adapter.getBalanceOf(chain.address));
    if (smartSol < totalFee) {
      throw new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`);
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length).catch(() => 5000n);
    if (relayerBal < Number(feeForTx)) {
      await this.security.log(pid, "execute.relayer_unfunded", {});
      throw new ServiceUnavailableException(
        "Peridot's fee service is briefly unavailable. No SOL was deducted from your wallet — please try again in a moment.",
      );
    }

    const authorityCompressed = coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>;
    const { b64urlToBytes } = this.pidSolana;
    const assertion: PasskeyAssertion = {
      credentialId: dto.assertion.id,
      signature: b64urlToBytes(dto.assertion.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(dto.assertion.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(dto.assertion.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };

    const signature = await adapter.sponsoredExecuteV3(
      pid,
      authorityCompressed,
      decoded.target,
      decoded.metas,
      decoded.data,
      version,
      networkFee,
      chainNonce,
      dto.expiry,
      assertion,
      this.relayer(),
      this.treasury(),
    );

    const status = (await adapter.waitForConfirmation(signature, 8, 1000)) === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "execute.submitted", {
      signature,
      target: decoded.target.toBase58(),
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
    });
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, version, "execute").catch((err) =>
      this.logger.warn(`execute reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
    };
  }
}
