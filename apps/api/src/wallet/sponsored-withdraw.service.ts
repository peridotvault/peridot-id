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
import { createHash } from "node:crypto";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { ACCOUNT_TYPE_SMART, SolanaSelection } from "../common/chains";
import { ChainRegistryService } from "../chain/chain-registry.service";
import {
  chainMinBaseUnits,
  exceedsDriftBound,
  exceedsMaxTotalFee,
  feePolicyVersion as configuredPolicyVersion,
  platformFeeOf,
  protocolFeeBps,
  QUOTE_TTL_SECS,
  relayerKeypair,
  solanaAdapter,
  treasuryPubkey,
} from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CircuitBreakerService } from "../relayer/circuit-breaker.service";
import {
  BROADCAST_CHAIN_SOLANA,
  ChainStateResolution,
  RelayerIdempotencyService,
} from "../relayer/relayer-idempotency.service";
import {
  IntentRejectionCause,
  RelayerEvents,
  SponsoredEntryPoint,
  absorbedLoss,
} from "../relayer/relayer-events";

export interface ChainEcho {
  namespace: "solana";
  reference: string;
}

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
  /** Additive CAIP-2 echo of the active Solana chain (omitted when registry has none). */
  chain?: ChainEcho;
  // --- Fee-policy v2 canonical quote shape (ANT-544 §4.1; contract-first field names) ---
  /** Canonical alias of networkFeeLamports (base units, decimal string). */
  networkFee: string;
  /** v2 platform fee: MAX(floor(networkFee×bps/10_000), chainMin) (base units). */
  platformFee: string;
  /** Solana-legacy alias of platformFee (lamports). */
  protocolFeeLamports: string;
  /** networkFee + platformFee at quote time (canonical alias of totalFeeLamports). */
  totalFee: string;
  /**
   * User-approved upper bound offered for the passkey-signed V4 authorization
   * (defaults to totalFee; the client MAY offer a higher bound for drift
   * headroom — submit enforces `totalFee ≤ maxTotalFee`, fail-closed).
   */
  maxTotalFee: string;
  /** Legacy alias of maxTotalFee (lamports). */
  suggestedMaxTotalFee: string;
  /** chainMin applied for this chain under the quoted policy version (base units). */
  chainMinBaseUnits: string;
  /** Informational quote id (submit re-attests — the id is not replay-checked). */
  quoteId: string;
  /** Quote timestamps (ISO-8601; `expiresAt − quotedAt` ≤ 300s, NFR-3). */
  quotedAt: string;
  expiresAt: string;
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
    private readonly idempotency: RelayerIdempotencyService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  private policyVersion(): number {
    return configuredPolicyVersion();
  }

  /** H1.ii: every pre-broadcast rejection writes a typed `intent.rejected` event. */
  private rejected(
    pid: string,
    entryPoint: SponsoredEntryPoint,
    cause: IntentRejectionCause,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    return this.security.log(pid, RelayerEvents.intentRejected, {
      entryPoint,
      chain: BROADCAST_CHAIN_SOLANA,
      cause,
      ...meta,
    });
  }

  /**
   * H2 slot key: sha256 over the canonical intent + the user's assertion
   * signature. Same signed intent ⇒ same hash (idempotent retry); a re-sign
   * under the same nonce ⇒ different hash ⇒ conflicting-nonce-reuse rejection.
   * Wire bytes (blockhash) may vary per attempt — replay safety is the nonce.
   */
  private intentHash(entryPoint: SponsoredEntryPoint, signatureB64: string, parts: unknown[]): string {
    const h = createHash("sha256");
    h.update(JSON.stringify([entryPoint, ...parts]));
    h.update(signatureB64);
    return h.digest("hex");
  }

  /**
   * H2.v duplicate-no-submission path: a previous attempt claimed the slot but
   * recorded no signature (crash between broadcast and record, or a concurrent
   * in-flight attempt). Resolve chain state before any rebroadcast. Returns
   * the duplicate response when chain state proves landing, or null to fall
   * through to the single allowed broadcast on proven non-landing.
   */
  private async resolveDuplicateSlot(
    pid: string,
    adapter: SolanaAdapter,
    accountAddress: string,
    entryPoint: SponsoredEntryPoint,
    nonce: string,
    chainNonce: bigint,
    networkFee: bigint,
    protocolFee: bigint,
  ): Promise<SponsoredWithdrawResult | null> {    const state = await this.resolveSvmState(adapter, pid, accountAddress, chainNonce).catch(() => ({
      unreadable: true as const,
    }));
    if ("unreadable" in state) {
      throw new ServiceUnavailableException(
        "The network outcome is unclear and the request was parked for operator review — no funds moved twice",
      );
    }
    if (!state.landed) return null;
    if (!state.signature) {
      await this.security.log(pid, RelayerEvents.resolvedLanded, {
        entryPoint,
        chain: BROADCAST_CHAIN_SOLANA,
        nonce,
        unattributed: true,
      });
      throw new ServiceUnavailableException(
        "The transaction landed but its receipt is unreadable — support has been alerted, please check state before retrying",
      );
    }
    await this.idempotency.recordOutcome(pid, nonce, BROADCAST_CHAIN_SOLANA, entryPoint, "resolved-landed", state.signature);
    return {
      signature: state.signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status: "confirmed",
    };
  }
  private async resolveSvmState(
    adapter: SolanaAdapter,
    pid: string,
    accountAddress: string,
    expectedNonce: bigint,
  ): Promise<ChainStateResolution> {
    // H2.v ground truth: the account nonce. Consumed nonce ⇒ the authorization
    // landed (attribute the newest confirmed account tx; null when history is
    // unreadable — still landed). Unconsumed nonce ⇒ proven non-landing.
    // Throwing readers ⇒ unreadable (bounded by the caller's resolve budget).
    const nonceNow = await adapter.getNonce(pid);
    if (nonceNow !== expectedNonce) {
      const history = await adapter.getHistory(accountAddress, 5);
      const hit = history.find((tx) => !tx.err);
      return { landed: true, signature: hit?.signature ?? null };
    }
    return { landed: false };
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

  /** Parse a user-supplied base-unit amount, mapping garbage to 400 (never 500). */
  private amountOr400(value: string, what: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${what} must be a positive integer`);
    return BigInt(value);
  }

  /**
   * Fee-policy v2 quote envelope shared by withdraw + execute quotes.
   * `maxTotalFee` offered defaults to `totalFee`; the client MAY raise it
   * before passkey-signing (drift headroom) — submit enforces the signed bound.
   */
  private quoteEnvelope(networkFee: bigint, version: number, chainTime: number, treasury: string) {
    const bps = protocolFeeBps(version);
    const platformFee = platformFeeOf(networkFee, "solana", version);
    const totalFee = networkFee + platformFee;
    const quotedAt = new Date(chainTime * 1000);
    const expiresAt = new Date(quotedAt.getTime() + QUOTE_TTL_SECS * 1000);
    return {
      networkFeeLamports: networkFee.toString(),
      protocolFeeBps: bps,
      feePolicyVersion: version,
      totalFeeLamports: totalFee.toString(),
      chainTime,
      treasury,
      networkFee: networkFee.toString(),
      platformFee: platformFee.toString(),
      protocolFeeLamports: platformFee.toString(),
      totalFee: totalFee.toString(),
      maxTotalFee: totalFee.toString(),
      suggestedMaxTotalFee: totalFee.toString(),
      chainMinBaseUnits: chainMinBaseUnits("solana", version).toString(),
      quoteId: `q_sol_${chainTime}_${networkFee.toString(36)}`,
      quotedAt: quotedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }
  /** Parse a user-supplied base58 address, mapping constructor throws to 400 (never 500). */
  private pubkeyOr400(PublicKeyCtor: new (v: string) => PublicKey, value: string, what: string): PublicKey {
    try {
      return new PublicKeyCtor(value);
    } catch {
      throw new BadRequestException(`${what} is not a valid Solana address`);
    }
  }

  private async adapter(selection?: SolanaSelection): Promise<SolanaAdapter> {
    const [rpcUrl, programId] = await Promise.all([this.chains.solanaRpcUrl(selection), this.chains.solanaProgramId(selection)]);
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
  async quote(pid: string, selection?: SolanaSelection): Promise<WithdrawQuote> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const networkFee = await this.networkFeeLamports(adapter);
    const version = this.policyVersion();
    const chainTime = await adapter.chainTime();
    const solChain = await this.chains.solanaChain().catch(() => undefined);
    return {
      ...this.quoteEnvelope(networkFee, version, chainTime, this.treasury().toBase58()),
      ...(solChain ? { chain: { namespace: "solana" as const, reference: solChain.reference } } : {}),
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
      /**
       * User-approved upper bound on `networkFee + platformFee` carried by the
       * passkey-signed V4 authorization (spec B5). Enforced pre-broadcast,
       * fail-closed (re-quote); exact equality passes.
       */
      maxTotalFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(pid, BROADCAST_CHAIN_SOLANA, "withdraw");

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      await this.rejected(pid, "withdraw", "unauthorized", { credentialId: dto.assertion.id });
      throw new BadRequestException("Unknown or inactive passkey");
    }

    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException("Amount must be greater than 0");
    const version = this.policyVersion();
    if (dto.feePolicyVersion !== version) {
      await this.rejected(pid, "withdraw", "policy-unknown", { feePolicyVersion: dto.feePolicyVersion });
      throw new BadRequestException("Unsupported fee policy — re-quote and try again");
    }

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      await this.rejected(pid, "withdraw", "stale-nonce", { nonce: dto.nonce });
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) {
      await this.rejected(pid, "withdraw", "expired", { expiry: dto.expiry });
      throw new BadRequestException("Authorization expired — please try again");
    }
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      await this.rejected(pid, "withdraw", "over-ttl", { expiry: dto.expiry, chainTime });
      throw new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again");
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await this.networkFeeLamports(adapter);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.rejected(pid, "withdraw", "drift", {
        quoted: quoted.toString(),
        attested: networkFee.toString(),
      });
      await this.security.log(pid, RelayerEvents.quoteDriftRejected, {
        entryPoint: "withdraw",
        chain: BROADCAST_CHAIN_SOLANA,
        quoted: quoted.toString(),
        attested: networkFee.toString(),
      });
      throw new ConflictException("Network fee moved — re-quote and try again");
    }
    const protocolFee = platformFeeOf(networkFee, "solana", version);
    const totalFee = networkFee + protocolFee;

    // V4 user bound (spec B5/B-AC5): the passkey-signed authorization carries
    // `maxTotalFee`; the backend enforces `totalFee ≤ maxTotalFee` pre-broadcast
    // (fail-closed re-quote). The on-chain V4 program enforces the same bound;
    // V3 payloads stay frozen (Troy, ANT-556).
    const maxTotalFee = this.amountOr400(dto.maxTotalFeeLamports, "Max total fee");
    if (exceedsMaxTotalFee(totalFee, maxTotalFee)) {
      await this.security.log(pid, "withdraw.max_total_exceeded", {
        totalFee: totalFee.toString(),
        maxTotalFee: maxTotalFee.toString(),
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
      });
      throw new ConflictException("Total fee exceeds your authorized maximum — re-quote and try again");
    }

    if (dto.to === chain.address) {
      throw new BadRequestException("Destination cannot be the smart account");
    }
    if (dto.asset === "SOL") {
      const smart = BigInt(await adapter.getBalanceOf(chain.address));
      if (smart < amount + totalFee) {
        await this.rejected(pid, "withdraw", "insufficient-funds", { asset: dto.asset });
        throw new BadRequestException(
          `Insufficient balance — need ${amount + totalFee} lamports, have ${smart}`,
        );
      }
    } else {
      const { PublicKey } = this.pidSolana;
      const mint = this.pubkeyOr400(PublicKey, dto.asset, "Asset mint");
      const sourceAta = await adapter.tokenAta(pid, mint);
      const balances = await adapter.getTokenBalancesOf(sourceAta.toBase58()).catch(() => []);
      const row = balances.find((b) => b.mint === mint.toBase58());
      if (!row || BigInt(row.amount) < amount) {
        await this.rejected(pid, "withdraw", "insufficient-funds", { asset: dto.asset });
        throw new BadRequestException("Insufficient token balance");
      }
      const smartSol = BigInt(await adapter.getBalanceOf(chain.address));
      if (smartSol < totalFee) {
        await this.rejected(pid, "withdraw", "insufficient-funds", { asset: dto.asset });
        throw new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`);
      }
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateWithdrawFee().catch(() => 5000n);
    if (BigInt(relayerBal) < feeForTx) {
      await this.rejected(pid, "withdraw", "relayer-unfunded", {});
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

    // H2: claim the (pid, nonce, chain) slot. Same-signed-intent retries return
    // the recorded signature with no new broadcast; different bytes under the
    // same nonce throw (conflicting submissions are forbidden).
    const slotHash = this.intentHash("withdraw", dto.assertion.signature, [
      dto.asset,
      dto.to,
      dto.amount,
      dto.nonce,
      dto.expiry,
      version,
    ]);
    const claim = await this.idempotency.claimSlot(
      pid,
      dto.nonce,
      BROADCAST_CHAIN_SOLANA,
      slotHash,
      "withdraw",
    );
    if (claim.decision === "duplicate" && claim.signature) {
      return {
        signature: claim.signature,
        networkFeeLamports: networkFee.toString(),
        protocolFeeLamports: protocolFee.toString(),
        status: "confirmed",
      };
    }
    if (claim.decision === "duplicate") {
      const resolved = await this.resolveDuplicateSlot(
        pid,
        adapter,
        chain.address,
        "withdraw",
        dto.nonce,
        chainNonce,
        networkFee,
        protocolFee,
      );
      if (resolved) return resolved;
      // Proven non-landing → fall through to the single allowed broadcast.
    }

    let signature: string | null;
    if (dto.asset === "SOL") {
      const out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: () =>
          adapter
            .sponsoredWithdrawSolV3(
              pid,
              authorityCompressed,
              this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              version,
              networkFee,
              nonce,
              expiry,
              assertion,
              this.relayer(),
              this.treasury(),
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
      });
      signature = out.signature;
    } else {
      const mint = this.pubkeyOr400(PublicKey, dto.asset, "Asset mint");
      const sourceAta = await adapter.tokenAta(pid, mint);
      if (!(await adapter.hasAccount(sourceAta.toBase58()))) {
        throw new BadRequestException("Token account is not registered on this wallet yet");
      }
      const out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: () =>
          adapter
            .sponsoredWithdrawTokenV3(
              pid,
              authorityCompressed,
              mint,
              this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              version,
              networkFee,
              nonce,
              expiry,
              assertion as never,
              this.relayer(),
              this.treasury(),
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
      });
      signature = out.signature;
    }
    if (!signature) {
      // Proven landed but unattributed (nonce consumed, history unreadable):
      // reconcile what can be reconciled and alert — never rebroadcast.
      await this.security.log(pid, RelayerEvents.resolvedLanded, {
        entryPoint: "withdraw",
        chain: BROADCAST_CHAIN_SOLANA,
        nonce: dto.nonce,
        unattributed: true,
      });
      throw new ServiceUnavailableException(
        "The withdrawal landed but its receipt is unreadable — support has been alerted, please check your balance before retrying",
      );
    }

    const confirmation = await adapter.waitForConfirmation(signature, 8, 1000);
    if (confirmation === "failed") {
      // Post-confirmation failure: alert, never rebroadcast (H2.iii).
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "withdraw", "failed", signature);
      await this.security.log(pid, RelayerEvents.intentRejected, {
        entryPoint: "withdraw",
        chain: BROADCAST_CHAIN_SOLANA,
        cause: "post-confirmation-failure",
        signature,
      });
    }
    const status = confirmation === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "withdraw.submitted", {
      signature,
      amount: amount.toString(),
      asset: dto.asset,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
    });
    if (confirmation === "confirmed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "withdraw", "confirmed", signature);
    }
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
   * Post-confirmation reconciliation (spec E5): verify the program applied the
   * canonical v2 formula to the attested network fee, and that the attested fee
   * tracks the actual network charge. Divergence fires a security event + alert
   * log; relayer P&L (absorbed spikes) is logged per tx. The program guarantees
   * the rate and recipients; this guards the attested number.
   */
  private async reconcile(
    pid: string,
    adapter: SolanaAdapter,
    signature: string,
    networkFee: bigint,
    protocolFee: bigint,
    version: number,
    kind: SponsoredEntryPoint = "withdraw",
  ): Promise<void> {
    const expectedProtocol = platformFeeOf(networkFee, "solana", version);
    const parsed = await adapter.parseTransaction(signature).catch(() => null);
    const actual = parsed?.fee != null ? BigInt(parsed.fee) : null;
    const absorbed = absorbedLoss(networkFee, actual);
    const overAttested = actual != null && exceedsDriftBound(networkFee, actual);
    const formulaDiverged = protocolFee !== expectedProtocol;
    await this.security.log(pid, `${kind}.reconciled`, {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual?.toString() ?? "unknown",
      relayerAbsorbed: absorbed.toString(),
      overAttested,
      formulaDiverged,
    });
    // H1.iv: per-tx relayer P&L, dashboarded per chain + entry point.
    await this.security.log(pid, RelayerEvents.pnl, {
      signature,
      entryPoint: kind,
      chain: BROADCAST_CHAIN_SOLANA,
      absorbed: absorbed.toString(),
    });
    // H3: absorbed losses feed the per-chain spend-rate breaker.
    await this.breaker.recordAbsorbed(pid, BROADCAST_CHAIN_SOLANA, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
    if (formulaDiverged) {
      this.logger.error(`${kind} formula anomaly: ${signature} protocol=${protocolFee} expected=${expectedProtocol}`);
      await this.security.log(pid, `${kind}.fee_divergence`, {
        signature,
        protocolFee: protocolFee.toString(),
        protocolFeeExpected: expectedProtocol.toString(),
        networkFee: networkFee.toString(),
        feePolicyVersion: version,
      });
      // H1.iii: formula divergence — alert, never rebroadcast.
      await this.security.log(pid, RelayerEvents.formulaMismatch, {
        signature,
        entryPoint: kind,
        chain: BROADCAST_CHAIN_SOLANA,
        attested: networkFee.toString(),
        actual: actual?.toString() ?? "unknown",
        expected: expectedProtocol.toString(),
      });
    }
    if (overAttested) {
      await this.security.log(pid, RelayerEvents.overAttested, {
        signature,
        entryPoint: kind,
        chain: BROADCAST_CHAIN_SOLANA,
        attested: networkFee.toString(),
        actual: actual?.toString() ?? "unknown",
        expected: expectedProtocol.toString(),
      });
      this.logger.error(`${kind} over-attestation anomaly: ${signature} attested=${networkFee} actual=${actual}`);
      await this.security.log(pid, `${kind}.fee_divergence`, {
        signature,
        attestedNetworkFee: networkFee.toString(),
        actualNetworkFee: actual?.toString() ?? "unknown",
        feePolicyVersion: version,
      });
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
    selection?: SolanaSelection,
  ): Promise<{ target: PublicKey; metas: { address: PublicKey; writable: boolean; signer: boolean }[]; data: Uint8Array }> {
    const { PublicKey, b64urlToBytes } = this.pidSolana;
    const programId = await this.chains.solanaProgramId(selection);
    const target = this.pubkeyOr400(PublicKey, call.target, "Target");
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
    const metas = call.metas.map((m) => ({ address: this.pubkeyOr400(PublicKey, m.address, "Execute meta"), writable: m.writable, signer: m.signer }));
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
    selection?: SolanaSelection,
  ): Promise<WithdrawQuote> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const decoded = await this.decodeExecuteCall(chain.address, call, selection);
    const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
    const version = this.policyVersion();
    const chainTime = await adapter.chainTime();
    const solChain = await this.chains.solanaChain().catch(() => undefined);
    return {
      ...this.quoteEnvelope(networkFee, version, chainTime, this.treasury().toBase58()),
      ...(solChain ? { chain: { namespace: "solana" as const, reference: solChain.reference } } : {}),
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
      /**
       * User-approved upper bound on `networkFee + platformFee` carried by the
       * passkey-signed V4 authorization (spec B5). Enforced pre-broadcast,
       * fail-closed (re-quote); exact equality passes.
       */
      maxTotalFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    await this.assertActivated(adapter, chain.address);
    const decoded = await this.decodeExecuteCall(chain.address, dto, selection);

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(pid, BROADCAST_CHAIN_SOLANA, "execute");

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      await this.rejected(pid, "execute", "unauthorized", { credentialId: dto.assertion.id });
      throw new BadRequestException("Unknown or inactive passkey");
    }

    const version = this.policyVersion();
    if (dto.feePolicyVersion !== version) {
      await this.rejected(pid, "execute", "policy-unknown", { feePolicyVersion: dto.feePolicyVersion });
      throw new BadRequestException("Unsupported fee policy — re-quote and try again");
    }

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      await this.rejected(pid, "execute", "stale-nonce", { nonce: dto.nonce });
      throw new ConflictException("Authorization is stale — please try again (a newer nonce is active)");
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) {
      await this.rejected(pid, "execute", "expired", { expiry: dto.expiry });
      throw new BadRequestException("Authorization expired — please try again");
    }
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      await this.rejected(pid, "execute", "over-ttl", { expiry: dto.expiry, chainTime });
      throw new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again");
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.rejected(pid, "execute", "drift", {
        quoted: quoted.toString(),
        attested: networkFee.toString(),
      });
      await this.security.log(pid, RelayerEvents.quoteDriftRejected, {
        entryPoint: "execute",
        chain: BROADCAST_CHAIN_SOLANA,
        quoted: quoted.toString(),
        attested: networkFee.toString(),
      });
      throw new ConflictException("Network fee moved — re-quote and try again");
    }
    const protocolFee = platformFeeOf(networkFee, "solana", version);
    const totalFee = networkFee + protocolFee;

    // V4 user bound (spec B5/B-AC5): fail-closed pre-broadcast, like withdraw.
    const maxTotalFee = this.amountOr400(dto.maxTotalFeeLamports, "Max total fee");
    if (exceedsMaxTotalFee(totalFee, maxTotalFee)) {
      await this.security.log(pid, "execute.max_total_exceeded", {
        totalFee: totalFee.toString(),
        maxTotalFee: maxTotalFee.toString(),
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
      });
      throw new ConflictException("Total fee exceeds your authorized maximum — re-quote and try again");
    }

    // The generic call executes with full PDA authority: inner programs CAN debit
    // PDA-owned lamports/ATAs via the PDA-signer CPI; only the fee split is
    // balance-checked pre-broadcast. Safety rests on the passkey-signed call_hash
    // (program-verified, see contracts/svm/smart-account/src/instructions/execute.rs:162-172)
    // + user intent.
    const smartSol = BigInt(await adapter.getBalanceOf(chain.address));
    if (smartSol < totalFee) {
      await this.rejected(pid, "execute", "insufficient-funds", {});
      throw new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`);
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length).catch(() => 5000n);
    if (BigInt(relayerBal) < feeForTx) {
      await this.rejected(pid, "execute", "relayer-unfunded", {});
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

    // H2: claim the (pid, nonce, chain) slot (same semantics as withdraw).
    const slotHash = this.intentHash("execute", dto.assertion.signature, [
      dto.target,
      dto.data,
      dto.nonce,
      dto.expiry,
      version,
    ]);
    const claim = await this.idempotency.claimSlot(
      pid,
      dto.nonce,
      BROADCAST_CHAIN_SOLANA,
      slotHash,
      "execute",
    );
    if (claim.decision === "duplicate" && claim.signature) {
      return {
        signature: claim.signature,
        networkFeeLamports: networkFee.toString(),
        protocolFeeLamports: protocolFee.toString(),
        status: "confirmed",
      };
    }
    if (claim.decision === "duplicate") {
      const resolved = await this.resolveDuplicateSlot(
        pid,
        adapter,
        chain.address,
        "execute",
        dto.nonce,
        chainNonce,
        networkFee,
        protocolFee,
      );
      if (resolved) return resolved;
      // Proven non-landing → fall through to the single allowed broadcast.
    }

    const out = await this.idempotency.broadcastWithResolveThenAct({
      pid,
      nonce: dto.nonce,
      chain: BROADCAST_CHAIN_SOLANA,
      entryPoint: "execute",
      broadcast: () =>
        adapter
          .sponsoredExecuteV3(
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
          )
          .then((sig) => ({ signature: sig, result: null })),
      resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
    });
    const signature = out.signature;
    if (!signature) {
      await this.security.log(pid, RelayerEvents.resolvedLanded, {
        entryPoint: "execute",
        chain: BROADCAST_CHAIN_SOLANA,
        nonce: dto.nonce,
        unattributed: true,
      });
      throw new ServiceUnavailableException(
        "The transaction landed but its receipt is unreadable — support has been alerted, please check state before retrying",
      );
    }

    const confirmation = await adapter.waitForConfirmation(signature, 8, 1000);
    if (confirmation === "failed") {
      // Post-confirmation failure: alert, never rebroadcast (H2.iii).
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "execute", "failed", signature);
      await this.security.log(pid, RelayerEvents.intentRejected, {
        entryPoint: "execute",
        chain: BROADCAST_CHAIN_SOLANA,
        cause: "post-confirmation-failure",
        signature,
      });
    }
    const status = confirmation === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "execute.submitted", {
      signature,
      target: decoded.target.toBase58(),
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
      dataLen: decoded.data.length,
      metaCount: decoded.metas.length,
    });
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, version, "execute").catch((err) =>
      this.logger.warn(`execute reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    if (status === "confirmed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "execute", "confirmed", signature);
    }
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
    };
  }
}
