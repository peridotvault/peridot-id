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
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccount } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { ACCOUNT_TYPE_SMART, SolanaSelection, solanaReferenceFor } from "../common/chains";
import { ChainRegistryService } from "../chain/chain-registry.service";
import {
  exceedsDriftBound,
  exceedsMaxTotalFee,
  feePolicyVersion as configuredPolicyVersion,
  protocolFeeBps,
  protocolFeeOf,
  QUOTE_TTL_SECS,
  relayerKeypair,
  solanaAdapter,
} from "../common/solana-relay";
import { FeePolicyService } from "../fee/fee-policy.service";
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
  RelayerH1Events,
  SponsoredEntryPoint,
  absorbedLoss,
  fmtBaseUnits,
} from "../relayer/relayer-events";

export interface ChainEcho {
  namespace: "solana";
  reference: string;
}

/**
 * ANT-729 (WS3, spec WS1 §7.1): lazy-activation segment of a quote. Always
 * present so clients never branch on version: `mode: "none"` + `required:
 * false` preserves today's behavior byte-for-byte for ACTIVE accounts (AC-15).
 */
export type ActivationMode = "none" | "svm-composite" | "svm-fallback-2step";
export interface ActivationQuote {
  /** True when the account is not yet ACTIVE and this quote funds its creation. */
  required: boolean;
  /** True when `estimate` is already inside `totalFee` (no hidden surcharge). */
  includedInTotal: boolean;
  /** Base-unit estimate of the creation cost (`rent(80B) + composite message fee`). */
  estimate: string;
  /** Human-readable basis of `estimate` (audit trail, not machine-parsed). */
  estimateBasis: string;
  /** How the submit will land the activation (`none` = already ACTIVE). */
  mode: ActivationMode;
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
  /** platform fee: floor(networkFee×bps/10_000), pure percentage (base units). */
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
  /** minima leg — always "0" since ANT-743 (kept for shape compatibility). */
  chainMinBaseUnits: string;
  /** Informational quote id (submit re-attests — the id is not replay-checked). */
  quoteId: string;
  /** Quote timestamps (ISO-8601; `expiresAt − quotedAt` ≤ 300s, NFR-3). */
  quotedAt: string;
  expiresAt: string;
  /** Lazy-activation segment (spec WS1 §7.1; always present — AC-15). */
  activation: ActivationQuote;
}

/** Passkey-signed first-action authorization (spec WS1 §7.2). */
export interface FirstActionAuth {
  /** Chain-time expiry (unix seconds) the activation passkey signed against. */
  expiry: number;
  /** Signed fee-policy version for the activation leg (must equal quote version). */
  feePolicyVersion: number;
  /** The quoted activation estimate the client signed against (drift reference). */
  quotedActivationLamports: string;
  /** User-approved upper bound on the activation leg's `networkFee + platformFee`. */
  maxTotalFeeLamports: string;
  assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
}

export interface SponsoredWithdrawResult {
  signature: string;
  networkFeeLamports: string;
  protocolFeeLamports: string;
  status: "confirmed" | "pending";
  /** Present when the signed version trails the active policy by one (NFR-6/AC-11). */
  feePolicyWarning?: string;
  /** How the activation landed on a first-action submit (absent = already ACTIVE). */
  activation?: { mode: Exclude<ActivationMode, "none"> };
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
    @Optional() private readonly fees?: FeePolicyService,
  ) {}

  private policyVersion(): number {
    return configuredPolicyVersion();
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
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
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

  /** Parse a user-supplied base-unit amount, mapping garbage to 400 (never 500). */
  private amountOr400(value: string, what: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${what} must be a positive integer`);
    return BigInt(value);
  }

  /**
   * Quoting leg for one Solana cluster (ANT-743: pure percentage — the
   * fee-policy service supplies version + bps; the minima leg is always 0).
   * Frozen in-code bps apply when the service/row is absent.
   */
  private async solanaFeeLeg(
    selection?: SolanaSelection,
    version?: number,
  ): Promise<{ version: number; bps: number; chainMin: bigint }> {
    const reference = solanaReferenceFor(selection ?? "devnet");
    if (this.fees) {
      if (version === undefined) {
        const m = await this.fees.minFeeFor("solana", reference);
        return { version: m.version, bps: m.bps, chainMin: 0n };
      }
      const leg = await this.fees.minFeeForVersion("solana", reference, version).catch(() => undefined);
      if (leg) return { version, bps: leg.bps, chainMin: 0n };
    }
    const v = version ?? this.policyVersion();
    return { version: v, bps: protocolFeeBps(v), chainMin: 0n };
  }

  /**
   * Submit-time version gate (spec §4.3, NFR-6/AC-11): the active version and
   * one version back are accepted (older with a warning); anything older is
   * StaleQuote (410), anything unknown is UnknownFeePolicy (400). Without
   * the fee service the frozen exact-match rule applies (previous behavior).
   */
  private async gateSubmitVersion(
    pid: string,
    entryPoint: SponsoredEntryPoint,
    nonce: string,
    submitted: number,
  ): Promise<string | undefined> {
    if (!this.fees) {
      if (submitted !== this.policyVersion()) {
        return this.reject(
          pid,
          entryPoint,
          nonce,
          "policy-unknown",
          new BadRequestException({ code: "UnknownFeePolicy", message: "Unsupported fee policy — re-quote and try again" }),
        );
      }
      return undefined;
    }
    const gate = await this.fees.checkSubmitVersion(submitted);
    if (!gate.ok) {
      return this.reject(
        pid,
        entryPoint,
        nonce,
        "policy-unknown",
        gate.status === 410
          ? new GoneException({ code: gate.code, message: gate.message })
          : new BadRequestException({ code: gate.code, message: gate.message }),
      );
    }
    return gate.warning;
  }

  /**
   * Fee-policy v2 quote envelope shared by withdraw + execute quotes.
   * `maxTotalFee` offered defaults to `totalFee`; the client MAY raise it
   * before passkey-signing (drift headroom) — submit enforces the signed bound.
   */
  private quoteEnvelope(
    networkFee: bigint,
    leg: { version: number; bps: number; chainMin: bigint },
    chainTime: number,
    treasury: string,
  ) {
    const platformFee = protocolFeeOf(networkFee, leg.bps);
    const totalFee = networkFee + platformFee;
    const quotedAt = new Date(chainTime * 1000);
    const expiresAt = new Date(quotedAt.getTime() + QUOTE_TTL_SECS * 1000);
    return {
      networkFeeLamports: networkFee.toString(),
      protocolFeeBps: leg.bps,
      feePolicyVersion: leg.version,
      totalFeeLamports: totalFee.toString(),
      chainTime,
      treasury,
      networkFee: networkFee.toString(),
      platformFee: platformFee.toString(),
      protocolFeeLamports: platformFee.toString(),
      totalFee: totalFee.toString(),
      maxTotalFee: totalFee.toString(),
      suggestedMaxTotalFee: totalFee.toString(),
      chainMinBaseUnits: leg.chainMin.toString(),
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

  /**
   * H1.ii: every semantic intent rejection emits intent.rejected with the exact
   * contract keys { chain, entryPoint, cause, nonce } before the error is
   * thrown. Malformed-shape 400s (bad base58, oversize calldata) stay unlogged
   * — they are client bugs, not rejection signals.
   */
  private async reject(
    pid: string,
    entryPoint: SponsoredEntryPoint,
    nonce: string,
    cause: IntentRejectionCause,
    err: Error,
  ): Promise<never> {
    await this.security.log(pid, RelayerH1Events.intentRejected, {
      chain: "solana",
      entryPoint,
      cause,
      nonce,
    });
    throw err;
  }

  /** H1.v: quote drift rejections emit the quoted vs attested pair (base units). */
  private async driftRejected(pid: string, entryPoint: SponsoredEntryPoint, quoted: bigint, attested: bigint): Promise<void> {
    await this.security.log(pid, RelayerH1Events.driftRejected, {
      chain: "solana",
      entryPoint,
      quoted: fmtBaseUnits(quoted),
      attested: fmtBaseUnits(attested),
    });
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
    if (!(await this.isActivated(adapter, address))) {
      throw new ConflictException("Wallet must be activated before sending");
    }
  }

  /**
   * ANT-729 (WS3): activation probe. `false` routes the caller into the lazy
   * first-action path — it is never a rejection reason for a first action
   * (spec WS1 §3.3, AC-5). `assertActivated` above stays only for call sites
   * that genuinely require a pre-existing account.
   */
  private async isActivated(adapter: SolanaAdapter, address: string): Promise<boolean> {
    try {
      return await adapter.isActivated(address);
    } catch {
      return false;
    }
  }

  /** No-op activation segment for ACTIVE accounts (backward compat — AC-15). */
  private noActivation(): ActivationQuote {
    return {
      required: false,
      includedInTotal: false,
      estimate: "0",
      estimateBasis: "account-active",
      mode: "none",
    };
  }

  /** Realtime network-cost estimate (no margin — the protocol fee is a separate percentage). */
  private async networkFeeLamports(adapter: SolanaAdapter): Promise<bigint> {
    return adapter.estimateWithdrawFee();
  }

  /** Compute the quote the client signs the policy (not amounts) against. */
  async quote(pid: string, selection?: SolanaSelection): Promise<WithdrawQuote> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    const leg = await this.solanaFeeLeg(selection);
    const chainTime = await adapter.chainTime();
    const solChain = await this.chains.solanaChain(selection).catch(() => undefined);
    const chainEcho = solChain ? { chain: { namespace: "solana" as const, reference: solChain.reference } } : {};
    if (await this.isActivated(adapter, chain.address)) {
      const networkFee = await this.networkFeeLamports(adapter);
      return {
        ...this.quoteEnvelope(networkFee, leg, chainTime, adapter.treasuryAddress().toBase58()),
        activation: this.noActivation(),
        ...chainEcho,
      };
    }
    // ANT-729 (WS3) first action: the quote funds creation — networkFee is the
    // full attested base `rent(80B) + getFeeForMessage(composite)`, quoted
    // under the DB-first leg (pure percentage since ANT-743).
    const [compositeFee, rent] = await Promise.all([
      adapter.estimateCompositeWithdrawFee(),
      adapter.rentExemption(),
    ]);
    const networkFee = compositeFee + rent;
    return {
      ...this.quoteEnvelope(networkFee, leg, chainTime, adapter.treasuryAddress().toBase58()),
      activation: {
        required: true,
        includedInTotal: true,
        estimate: networkFee.toString(),
        estimateBasis: `rent(80B,${rent})+getFeeForMessage(composite-activate_v4+withdraw_sol_v4,${compositeFee})`,
        mode: "svm-composite",
      },
      ...chainEcho,
    };
  }

  /** Decode a client-supplied assertion into adapter wire shape (throws 400 on garbage). */
  private toPasskeyAssertion(a: { id: string; signature: string; authenticatorData: string; clientDataJSON: string }): PasskeyAssertion {
    const { b64urlToBytes } = this.pidSolana;
    return {
      credentialId: a.id,
      signature: b64urlToBytes(a.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(a.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(a.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };
  }

  /**
   * ANT-729 (WS3): lazy first-action withdraw — `[activate_v4 + spend]` in one
   * atomic tx, with automatic 2-step fallback (relayer-float + claim) when the
   * composite exceeds the packet ceiling. Same 1-click UX either way; the
   * result reports which mode landed (spec WS1 §3.2, AC-3/AC-4).
   *
   * Lenses: checks-effects-interactions (FeeExceedsMax pre-claim, slot claim
   * pre-broadcast); reorg/finality (waitForConfirmation, H2 resolve paths
   * reused); gas (rent 80B basis, composite message fee attested 1:1).
   */
  private async withdrawFirstAction(
    pid: string,
    adapter: SolanaAdapter,
    accountAddress: string,
    dto: {
      asset: string;
      to: string;
      amount: string;
      nonce: string;
      expiry: number;
      feePolicyVersion: number;
      quotedNetworkFeeLamports: string;
      maxTotalFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
      activation?: FirstActionAuth;
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    if (!dto.activation) {
      // Fail-closed re-quote — the client must sign the activation leg too.
      // This is lazy routing, NOT an activation gate (AC-5).
      throw new ConflictException(
        "Account is not active yet — re-quote for first action and sign the activation segment",
      );
    }
    const first = dto.activation;

    await this.breaker.requireClosed(BROADCAST_CHAIN_SOLANA, "withdraw");

    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      return this.reject(pid, "withdraw", dto.nonce, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
    }
    if (first.assertion.id !== dto.assertion.id) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "unauthorized",
        new BadRequestException("Activation and spend must be signed by the same passkey"),
      );
    }

    const amount = this.amountOr400(dto.amount, "Amount");
    if (amount <= 0n) throw new BadRequestException("Amount must be greater than 0");
    // Submit settles under the SIGNED version (NFR-6: active + one-back with a
    // warning via gateSubmitVersion); activation and spend must settle the
    // same version (one intent, one fee leg).
    const feePolicyWarning = await this.gateSubmitVersion(pid, "withdraw", dto.nonce, dto.feePolicyVersion);
    const version = dto.feePolicyVersion;
    if (first.feePolicyVersion !== version) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "policy-unknown",
        new BadRequestException("Activation and spend must be quoted under the same fee policy version"),
      );
    }
    const leg = await this.solanaFeeLeg(selection, version);

    // Nonce starts at 0 for an uninitialized PDA; any other value is stale.
    const chainNonce = await adapter.getNonce(pid).catch(() => 0n);
    if (BigInt(dto.nonce) !== chainNonce) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "stale-nonce",
        new ConflictException("Authorization is stale — please try again (a newer nonce is active)"),
      );
    }
    const chainTime = await adapter.chainTime();
    for (const exp of [dto.expiry, first.expiry]) {
      if (exp <= chainTime) {
        return this.reject(pid, "withdraw", dto.nonce, "expired", new BadRequestException("Authorization expired — please try again"));
      }
      if (exp - chainTime > MAX_TTL_SECS) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "expired",
          new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"),
        );
      }
    }

    // Attest the full first-action base: rent(80B) + composite message fee.
    // Drift and maxTotalFee are enforced BEFORE any claim (no half-activated
    // state can burn fee — AC-3; `FeeExceedsMax` pre-claim per §3.2).
    const [compositeFee, rent] = await Promise.all([
      adapter.estimateCompositeWithdrawFee(),
      adapter.rentExemption(),
    ]);
    const networkFee = compositeFee + rent;
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.driftRejected(pid, "withdraw", quoted, networkFee);
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "drift",
        new ConflictException("Network fee moved — re-quote and try again"),
      );
    }
    const protocolFee = protocolFeeOf(networkFee, leg.bps);
    const totalFee = networkFee + protocolFee;
    const maxTotalFee = this.amountOr400(dto.maxTotalFeeLamports, "Max total fee");
    if (exceedsMaxTotalFee(totalFee, maxTotalFee)) {
      await this.security.log(pid, "withdraw.max_total_exceeded", {
        firstAction: true,
        totalFee: totalFee.toString(),
        maxTotalFee: maxTotalFee.toString(),
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
      });
      throw new ConflictException("Total fee exceeds your authorized maximum — re-quote and try again");
    }

    if (dto.to === accountAddress) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "policy-unknown",
        new BadRequestException("Destination cannot be the smart account"),
      );
    }
    // Prefund lives at the PDA pre-activation — same balance math as normal.
    if (dto.asset === "SOL") {
      const smart = BigInt(await adapter.getBalanceOf(accountAddress));
      if (smart < amount + totalFee) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "insufficient-funds",
          new BadRequestException(`Insufficient balance — need ${amount + totalFee} lamports, have ${smart}`),
        );
      }
    } else {
      const smartSol = BigInt(await adapter.getBalanceOf(accountAddress));
      if (smartSol < totalFee) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "insufficient-funds",
          new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`),
        );
      }
    }

    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    if (BigInt(relayerBal) < compositeFee) {
      await this.security.log(pid, "withdraw.relayer_unfunded", { firstAction: true });
      throw new ServiceUnavailableException(
        "Peridot's fee service is briefly unavailable. No SOL was deducted from your wallet — please try again in a moment.",
      );
    }

    const authorityCompressed = coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>;
    const spendAssertion = this.toPasskeyAssertion(dto.assertion);
    const activateAssertion = this.toPasskeyAssertion(first.assertion);
    const { PublicKey } = this.pidSolana;
    const activateLeg = {
      feePolicyVersion: version,
      networkFeeLamports: networkFee,
      maxTotalFeeLamports: this.amountOr400(first.maxTotalFeeLamports, "Activation max total fee"),
      expiry: first.expiry,
      assertion: activateAssertion,
    };
    if (exceedsMaxTotalFee(totalFee, activateLeg.maxTotalFeeLamports)) {
      throw new ConflictException("Total fee exceeds your authorized activation maximum — re-quote and try again");
    }

    const slotHash = this.intentHash("withdraw", dto.assertion.signature, [
      dto.asset,
      dto.to,
      dto.amount,
      dto.nonce,
      dto.expiry,
      version,
      "first-action",
      first.assertion.signature,
    ]);
    const claim = await this.idempotency.claimSlot(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, slotHash, "withdraw");
    if (claim.decision === "duplicate" && claim.signature) {
      return {
        signature: claim.signature,
        networkFeeLamports: networkFee.toString(),
        protocolFeeLamports: protocolFee.toString(),
        status: "confirmed",
        ...(feePolicyWarning ? { feePolicyWarning } : {}),
      };
    }
    if (claim.decision === "duplicate") {
      const resolved = await this.resolveDuplicateSlot(pid, adapter, accountAddress, "withdraw", dto.nonce, chainNonce, networkFee, protocolFee);
      if (resolved) return resolved;
    }

    let mode: Exclude<ActivationMode, "none"> = "svm-composite";
    const broadcastComposite = (): Promise<{ signature: string; result: null }> => {
      if (dto.asset === "SOL") {
        return adapter
          .sponsoredActivatePlusWithdrawSolV4(
            pid,
            authorityCompressed,
            activateLeg,
            {
              destination: this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              feePolicyVersion: version,
              networkFeeLamports: networkFee,
              maxTotalFeeLamports: maxTotalFee,
              nonce: chainNonce,
              expiry: dto.expiry,
              assertion: spendAssertion,
            },
            this.relayer(),
            undefined,
          )
          .then((sig) => ({ signature: sig, result: null }));
      }
      const mint = this.pubkeyOr400(PublicKey, dto.asset, "Asset mint");
      return adapter
        .tokenAta(pid, mint)
        .then((ata) =>
          adapter.sponsoredActivatePlusWithdrawTokenV4(
            pid,
            authorityCompressed,
            activateLeg,
            {
              mint,
              destinationAta: this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              feePolicyVersion: version,
              networkFeeLamports: networkFee,
              maxTotalFeeLamports: maxTotalFee,
              nonce: chainNonce,
              expiry: dto.expiry,
              assertion: spendAssertion,
            },
            this.relayer(),
            undefined,
          ),
        )
        .then((sig) => ({ signature: sig, result: null }));
    };

    let out: { signature: string | null };
    try {
      out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: broadcastComposite,
        resolveState: () => this.resolveSvmState(adapter, pid, accountAddress, chainNonce),
      });
    } catch (err) {
      // TxTooLarge ⇒ automatic 2-step fallback, identical UX (AC-4).
      if (!(err instanceof Error) || !/TxTooLarge/.test(err.message)) throw err;
      mode = "svm-fallback-2step";
      await this.security.log(pid, "withdraw.first_action_fallback", { reason: "tx-too-large", mode });
      const relayer = this.relayer();
      await adapter.activateV4(pid, authorityCompressed, version, networkFee, activateLeg.maxTotalFeeLamports, first.expiry, relayer, undefined, activateAssertion);
      const fallbackSpend = (): Promise<{ signature: string; result: null }> => {
        if (dto.asset === "SOL") {
          return adapter
            .sponsoredWithdrawSolV4(
              pid, authorityCompressed,
              this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount, version, networkFee, maxTotalFee, chainNonce, dto.expiry, spendAssertion, relayer, undefined,
            )
            .then((sig) => ({ signature: sig, result: null }));
        }
        return adapter
          .sponsoredWithdrawTokenV4(
            pid, authorityCompressed,
            this.pubkeyOr400(PublicKey, dto.asset, "Asset mint"),
            this.pubkeyOr400(PublicKey, dto.to, "Destination"),
            amount, version, networkFee, maxTotalFee, chainNonce, dto.expiry, spendAssertion, relayer, undefined,
          )
          .then((sig) => ({ signature: sig, result: null }));
      };
      // Retry-safe: if the process dies between the two steps, the account is
      // ACTIVE and the same nonce retries through the normal withdraw path.
      out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: fallbackSpend,
        resolveState: () => this.resolveSvmState(adapter, pid, accountAddress, chainNonce),
      });
    }
    const signature = out.signature;
    if (!signature) {
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
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
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "withdraw", "failed", signature);
      await this.security.log(pid, "withdraw.confirm_failed", { entryPoint: "withdraw", chain: BROADCAST_CHAIN_SOLANA, signature, firstAction: true, mode });
    }
    const status = confirmation === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "withdraw.submitted", {
      signature,
      amount: amount.toString(),
      asset: dto.asset,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
      firstAction: true,
      mode,
    });
    if (status === "confirmed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "withdraw", "confirmed", signature);
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        nonce: dto.nonce,
        signature,
      });
    }
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, leg).catch((err) =>
      this.logger.warn(`withdraw reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
      activation: { mode },
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
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
      /**
       * ANT-729 (WS3): first-action authorization. Required when the account
       * is not yet ACTIVE — the submit then lands `[activate_v4 + spend]`
       * atomically (or the automatic 2-step fallback) in the same 1-click
       * flow. Absent + inactive ⇒ fail-closed re-quote (never the legacy
       * "must be activated" rejection — AC-5).
       */
      activation?: FirstActionAuth;
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    if (!(await this.isActivated(adapter, chain.address))) {
      return this.withdrawFirstAction(pid, adapter, chain.address, dto, selection);
    }

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(BROADCAST_CHAIN_SOLANA, "withdraw");

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      return this.reject(pid, "withdraw", dto.nonce, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
    }

    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException("Amount must be greater than 0");
    // Submit settles under the SIGNED version (v1 traffic keeps v1 math).
    const feePolicyWarning = await this.gateSubmitVersion(pid, "withdraw", dto.nonce, dto.feePolicyVersion);
    const version = dto.feePolicyVersion;
    const leg = await this.solanaFeeLeg(selection, version);

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "stale-nonce",
        new ConflictException("Authorization is stale — please try again (a newer nonce is active)"),
      );
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) {
      return this.reject(pid, "withdraw", dto.nonce, "expired", new BadRequestException("Authorization expired — please try again"));
    }
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "expired",
        new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"),
      );
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await this.networkFeeLamports(adapter);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.driftRejected(pid, "withdraw", quoted, networkFee);
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "drift",
        new ConflictException("Network fee moved — re-quote and try again"),
      );
    }
    const protocolFee = protocolFeeOf(networkFee, leg.bps);
    const totalFee = networkFee + protocolFee;

    // V4 user bound (spec B5/B-AC5): the passkey-signed authorization carries
    // `maxTotalFee`; the backend enforces `totalFee ≤ maxTotalFee` pre-broadcast
    // (fail-closed re-quote). The on-chain V4 program enforces the same bound.
    // V3 is closed for new intents (ANT-800) — the frozen on-chain entrypoints
    // settle in-flight signatures only; this path broadcasts V4 exclusively.
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
      return this.reject(
        pid,
        "withdraw",
        dto.nonce,
        "policy-unknown",
        new BadRequestException("Destination cannot be the smart account"),
      );
    }
    if (dto.asset === "SOL") {
      const smart = BigInt(await adapter.getBalanceOf(chain.address));
      if (smart < amount + totalFee) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "insufficient-funds",
          new BadRequestException(
            `Insufficient balance — need ${amount + totalFee} lamports, have ${smart}`,
          ),
        );
      }
    } else {
      const { PublicKey } = this.pidSolana;
      const mint = this.pubkeyOr400(PublicKey, dto.asset, "Asset mint");
      const sourceAta = await adapter.tokenAta(pid, mint);
      const balances = await adapter.getTokenBalancesOf(sourceAta.toBase58()).catch(() => []);
      const row = balances.find((b) => b.mint === mint.toBase58());
      if (!row || BigInt(row.amount) < amount) {
        return this.reject(pid, "withdraw", dto.nonce, "insufficient-funds", new BadRequestException("Insufficient token balance"));
      }
      const smartSol = BigInt(await adapter.getBalanceOf(chain.address));
      if (smartSol < totalFee) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "insufficient-funds",
          new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`),
        );
      }
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateWithdrawFee().catch(() => 5000n);
    if (BigInt(relayerBal) < feeForTx) {
      // Service outage, not an intent rejection: no intent.rejected row (the
      // H1.ii cause set is closed and has no service-side cause).
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

    // ANT-800: ACTIVE path is V4-only (H1). V3 broadcast is closed: the
    // passkey-signed authorization carries `maxTotalFee` and the V4 program
    // enforces `total ≤ maxTotalFee` (FeeExceedsMax). Fee recipients stay
    // canonical (relayer signer + treasury PDA) — never caller-chosen (M1).
    let signature: string | null;
    if (dto.asset === "SOL") {
      const out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: () =>
          adapter
            .sponsoredWithdrawSolV4(
              pid,
              authorityCompressed,
              this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              version,
              networkFee,
              maxTotalFee,
              nonce,
              expiry,
              assertion,
              this.relayer(),
              undefined,
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
      });
      signature = out.signature;
    } else {
      const mint = this.pubkeyOr400(PublicKey, dto.asset, "Asset mint");
      const sourceAta = await adapter.tokenAta(pid, mint);
      if (!(await adapter.hasAccount(sourceAta.toBase58()))) {
        return this.reject(
          pid,
          "withdraw",
          dto.nonce,
          "policy-unknown",
          new BadRequestException("Token account is not registered on this wallet yet"),
        );
      }
      const out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        broadcast: () =>
          adapter
            .sponsoredWithdrawTokenV4(
              pid,
              authorityCompressed,
              mint,
              this.pubkeyOr400(PublicKey, dto.to, "Destination"),
              amount,
              version,
              networkFee,
              maxTotalFee,
              nonce,
              expiry,
              assertion as never,
              this.relayer(),
              undefined,
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
      });
      signature = out.signature;
    }
    if (!signature) {
      // Proven landed but unattributed (nonce consumed, history unreadable):
      // reconcile what can be reconciled and alert — never rebroadcast.
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
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
      // Post-confirmation failure is not an intent rejection (closed H1.ii
      // cause set): legacy-namespace alert row, never rebroadcast.
      await this.security.log(pid, "withdraw.confirm_failed", {
        entryPoint: "withdraw",
        chain: BROADCAST_CHAIN_SOLANA,
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
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
    });
    if (status === "confirmed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "withdraw", "confirmed", signature);
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "withdraw",
        nonce: dto.nonce,
        signature,
      });
    }
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, leg).catch((err) =>
      this.logger.warn(`withdraw reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
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
    leg: { version: number; bps: number; chainMin: bigint },
    kind: SponsoredEntryPoint = "withdraw",
  ): Promise<void> {
    const expectedProtocol = protocolFeeOf(networkFee, leg.bps);
    const parsed = await adapter.parseTransaction(signature).catch(() => null);
    const actual = parsed?.fee != null ? BigInt(parsed.fee) : null;
    const absorbed = absorbedLoss(networkFee, actual);
    const overAttested = actual != null && exceedsDriftBound(networkFee, actual);
    const formulaDiverged = protocolFee !== expectedProtocol;
    const actualStr = actual?.toString() ?? fmtBaseUnits(networkFee);
    await this.security.log(pid, `${kind}.reconciled`, {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual?.toString() ?? "unknown",
      relayerAbsorbed: fmtBaseUnits(absorbed),
      overAttested,
      formulaDiverged,
    });
    // H1.iv: per-tx relayer P&L, dashboarded per chain + entry point.
    await this.security.log(pid, RelayerH1Events.pnl, {
      chain: BROADCAST_CHAIN_SOLANA,
      entryPoint: kind,
      signature,
      absorbed: fmtBaseUnits(absorbed),
      attested: fmtBaseUnits(networkFee),
      actual: actualStr,
    });
    // H3: absorbed losses feed the per-chain spend-rate breaker.
    await this.breaker.recordAbsorbed(pid, BROADCAST_CHAIN_SOLANA, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
    if (formulaDiverged) {
      // H1.iii: protocol fee diverged from the canonical formula.
      await this.security.log(pid, RelayerH1Events.formulaMismatch, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: kind,
        signature,
        attested: fmtBaseUnits(networkFee),
        actual: actualStr,
        expected: fmtBaseUnits(expectedProtocol),
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(`${kind} formula anomaly: ${signature} protocol=${protocolFee} expected=${expectedProtocol}`);
      await this.security.log(pid, `${kind}.fee_divergence`, {
        signature,
        protocolFee: protocolFee.toString(),
        protocolFeeExpected: expectedProtocol.toString(),
        networkFee: networkFee.toString(),
        feePolicyVersion: leg.version,
      });
    }
    if (overAttested) {
      // H1.iii: attested fee exceeded the drift bound over the actual charge.
      await this.security.log(pid, RelayerH1Events.overAttested, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: kind,
        signature,
        attested: fmtBaseUnits(networkFee),
        actual: actualStr,
        expected: actualStr,
        absorbed: fmtBaseUnits(absorbed),
      });
      this.logger.error(`${kind} over-attestation anomaly: ${signature} attested=${networkFee} actual=${actual}`);
      await this.security.log(pid, `${kind}.fee_divergence`, {
        signature,
        attestedNetworkFee: networkFee.toString(),
        actualNetworkFee: actual?.toString() ?? "unknown",
        feePolicyVersion: leg.version,
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
    const leg = await this.solanaFeeLeg(selection);
    const chainTime = await adapter.chainTime();
    const solChain = await this.chains.solanaChain(selection).catch(() => undefined);
    const chainEcho = solChain ? { chain: { namespace: "solana" as const, reference: solChain.reference } } : {};
    const decoded = await this.decodeExecuteCall(chain.address, call, selection);
    if (await this.isActivated(adapter, chain.address)) {
      const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
      return {
        ...this.quoteEnvelope(networkFee, leg, chainTime, adapter.treasuryAddress().toBase58()),
        activation: this.noActivation(),
        ...chainEcho,
      };
    }
    // ANT-729 (WS3) first action: rent(80B) + composite message fee.
    const [compositeFee, rent] = await Promise.all([
      adapter.estimateCompositeExecuteFee(decoded.target, decoded.metas, decoded.data.length),
      adapter.rentExemption(),
    ]);
    const networkFee = compositeFee + rent;
    return {
      ...this.quoteEnvelope(networkFee, leg, chainTime, adapter.treasuryAddress().toBase58()),
      activation: {
        required: true,
        includedInTotal: true,
        estimate: networkFee.toString(),
        estimateBasis: `rent(80B,${rent})+getFeeForMessage(composite-activate_v4+execute_v4,${compositeFee})`,
        mode: "svm-composite",
      },
      ...chainEcho,
    };
  }

  /**
   * ANT-729 (WS3): lazy first-action execute — `[activate_v4 + execute_v4]`
   * atomically, else the automatic 2-step fallback. Mirrors
   * `withdrawFirstAction` (pre-claim FeeExceedsMax, H2 slot, reconcile).
   */
  private async executeFirstAction(
    pid: string,
    adapter: SolanaAdapter,
    accountAddress: string,
    decoded: { target: PublicKey; metas: { address: PublicKey; writable: boolean; signer: boolean }[]; data: Uint8Array },
    dto: {
      nonce: string;
      expiry: number;
      feePolicyVersion: number;
      quotedNetworkFeeLamports: string;
      maxTotalFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
      activation?: FirstActionAuth;
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    void selection;
    if (!dto.activation) {
      throw new ConflictException(
        "Account is not active yet — re-quote for first action and sign the activation segment",
      );
    }
    const first = dto.activation;

    await this.breaker.requireClosed(BROADCAST_CHAIN_SOLANA, "execute");

    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      return this.reject(pid, "execute", dto.nonce, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
    }
    if (first.assertion.id !== dto.assertion.id) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "unauthorized",
        new BadRequestException("Activation and spend must be signed by the same passkey"),
      );
    }

    // Submit settles under the SIGNED version (NFR-6: active + one-back with a
    // warning via gateSubmitVersion); activation and spend must settle the
    // same version (one intent, one fee leg).
    const feePolicyWarning = await this.gateSubmitVersion(pid, "execute", dto.nonce, dto.feePolicyVersion);
    const version = dto.feePolicyVersion;
    if (first.feePolicyVersion !== version) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "policy-unknown",
        new BadRequestException("Activation and spend must be quoted under the same fee policy version"),
      );
    }
    const leg = await this.solanaFeeLeg(selection, version);

    const chainNonce = await adapter.getNonce(pid).catch(() => 0n);
    if (BigInt(dto.nonce) !== chainNonce) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "stale-nonce",
        new ConflictException("Authorization is stale — please try again (a newer nonce is active)"),
      );
    }
    const chainTime = await adapter.chainTime();
    for (const exp of [dto.expiry, first.expiry]) {
      if (exp <= chainTime) {
        return this.reject(pid, "execute", dto.nonce, "expired", new BadRequestException("Authorization expired — please try again"));
      }
      if (exp - chainTime > MAX_TTL_SECS) {
        return this.reject(
          pid,
          "execute",
          dto.nonce,
          "expired",
          new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"),
        );
      }
    }

    const [compositeFee, rent] = await Promise.all([
      adapter.estimateCompositeExecuteFee(decoded.target, decoded.metas, decoded.data.length),
      adapter.rentExemption(),
    ]);
    const networkFee = compositeFee + rent;
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.driftRejected(pid, "execute", quoted, networkFee);
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "drift",
        new ConflictException("Network fee moved — re-quote and try again"),
      );
    }
    const protocolFee = protocolFeeOf(networkFee, leg.bps);
    const totalFee = networkFee + protocolFee;
    const maxTotalFee = this.amountOr400(dto.maxTotalFeeLamports, "Max total fee");
    if (exceedsMaxTotalFee(totalFee, maxTotalFee)) {
      await this.security.log(pid, "execute.max_total_exceeded", {
        firstAction: true,
        totalFee: totalFee.toString(),
        maxTotalFee: maxTotalFee.toString(),
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
      });
      throw new ConflictException("Total fee exceeds your authorized maximum — re-quote and try again");
    }

    // Fee must be covered by the prefunded PDA (no separate funding step).
    const smartSol = BigInt(await adapter.getBalanceOf(accountAddress));
    if (smartSol < totalFee) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "insufficient-funds",
        new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`),
      );
    }
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    if (BigInt(relayerBal) < compositeFee) {
      await this.security.log(pid, "execute.relayer_unfunded", { firstAction: true });
      throw new ServiceUnavailableException(
        "Peridot's fee service is briefly unavailable. No SOL was deducted from your wallet — please try again in a moment.",
      );
    }

    const authorityCompressed = coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>;
    const spendAssertion = this.toPasskeyAssertion(dto.assertion);
    const activateAssertion = this.toPasskeyAssertion(first.assertion);
    const activateLeg = {
      feePolicyVersion: version,
      networkFeeLamports: networkFee,
      maxTotalFeeLamports: this.amountOr400(first.maxTotalFeeLamports, "Activation max total fee"),
      expiry: first.expiry,
      assertion: activateAssertion,
    };
    if (exceedsMaxTotalFee(totalFee, activateLeg.maxTotalFeeLamports)) {
      throw new ConflictException("Total fee exceeds your authorized activation maximum — re-quote and try again");
    }

    const slotHash = this.intentHash("execute", dto.assertion.signature, [
      decoded.target.toBase58(),
      decoded.data.length,
      dto.nonce,
      dto.expiry,
      version,
      "first-action",
      first.assertion.signature,
    ]);
    const claim = await this.idempotency.claimSlot(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, slotHash, "execute");
    if (claim.decision === "duplicate" && claim.signature) {
      return {
        signature: claim.signature,
        networkFeeLamports: networkFee.toString(),
        protocolFeeLamports: protocolFee.toString(),
        status: "confirmed",
        ...(feePolicyWarning ? { feePolicyWarning } : {}),
      };
    }
    if (claim.decision === "duplicate") {
      const resolved = await this.resolveDuplicateSlot(pid, adapter, accountAddress, "execute", dto.nonce, chainNonce, networkFee, protocolFee);
      if (resolved) return resolved;
    }

    let mode: Exclude<ActivationMode, "none"> = "svm-composite";
    let out: { signature: string | null };
    try {
      out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "execute",
        broadcast: () =>
          adapter
            .sponsoredActivatePlusExecuteV4(
              pid,
              authorityCompressed,
              activateLeg,
              {
                target: decoded.target,
                metas: decoded.metas,
                data: decoded.data,
                feePolicyVersion: version,
                networkFeeLamports: networkFee,
                maxTotalFeeLamports: maxTotalFee,
                nonce: chainNonce,
                expiry: dto.expiry,
                assertion: spendAssertion,
              },
              this.relayer(),
              undefined,
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, accountAddress, chainNonce),
      });
    } catch (err) {
      if (!(err instanceof Error) || !/TxTooLarge/.test(err.message)) throw err;
      mode = "svm-fallback-2step";
      await this.security.log(pid, "execute.first_action_fallback", { reason: "tx-too-large", mode });
      const relayer = this.relayer();
      await adapter.activateV4(pid, authorityCompressed, version, networkFee, activateLeg.maxTotalFeeLamports, first.expiry, relayer, undefined, activateAssertion);
      // Retry-safe: ACTIVE + same nonce retries through the normal execute path.
      out = await this.idempotency.broadcastWithResolveThenAct({
        pid,
        nonce: dto.nonce,
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "execute",
        broadcast: () =>
          adapter
            .sponsoredExecuteV4(
              pid, authorityCompressed,
              decoded.target, decoded.metas, decoded.data,
              version, networkFee, maxTotalFee, chainNonce, dto.expiry, spendAssertion, relayer, undefined,
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: () => this.resolveSvmState(adapter, pid, accountAddress, chainNonce),
      });
    }
    const signature = out.signature;
    if (!signature) {
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
        entryPoint: "execute",
        chain: BROADCAST_CHAIN_SOLANA,
        nonce: dto.nonce,
        unattributed: true,
      });
      throw new ServiceUnavailableException(
        "The transaction landed but its receipt is unreadable — support has been alerted, please check your balance before retrying",
      );
    }

    const confirmation = await adapter.waitForConfirmation(signature, 8, 1000);
    if (confirmation === "failed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "execute", "failed", signature);
      await this.security.log(pid, "execute.confirm_failed", { entryPoint: "execute", chain: BROADCAST_CHAIN_SOLANA, signature, firstAction: true, mode });
    }
    const status = confirmation === "confirmed" ? "confirmed" : "pending";
    await this.security.log(pid, "execute.submitted", {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      feePolicyVersion: version,
      firstAction: true,
      mode,
    });
    if (status === "confirmed") {
      await this.idempotency.recordOutcome(pid, dto.nonce, BROADCAST_CHAIN_SOLANA, "execute", "confirmed", signature);
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "execute",
        nonce: dto.nonce,
        signature,
      });
    }
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, leg, "execute").catch((err) =>
      this.logger.warn(`execute reconcile failed for ${signature}: ${(err as Error).message}`),
    );
    return {
      signature,
      networkFeeLamports: networkFee.toString(),
      protocolFeeLamports: protocolFee.toString(),
      status,
      activation: { mode },
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
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
      /** ANT-729 (WS3): first-action authorization (required when not ACTIVE). */
      activation?: FirstActionAuth;
    },
    selection?: SolanaSelection,
  ): Promise<SponsoredWithdrawResult> {
    const adapter = await this.adapter(selection);
    const { chain } = await this.resolveSmart(pid);
    const preDecoded = await this.decodeExecuteCall(chain.address, dto, selection);
    if (!(await this.isActivated(adapter, chain.address))) {
      return this.executeFirstAction(pid, adapter, chain.address, preDecoded, dto, selection);
    }
    const decoded = preDecoded;

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(BROADCAST_CHAIN_SOLANA, "execute");

    // The asserting credential must be one of this wallet's active passkeys.
    const authority = await this.prisma.authority.findFirst({
      where: { pid, credentialId: dto.assertion.id, status: "active" },
    });
    if (!authority) {
      return this.reject(pid, "execute", dto.nonce, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
    }

    // Submit settles under the SIGNED version (v1 traffic keeps v1 math).
    const feePolicyWarning = await this.gateSubmitVersion(pid, "execute", dto.nonce, dto.feePolicyVersion);
    const version = dto.feePolicyVersion;
    const leg = await this.solanaFeeLeg(selection, version);

    // Stale-nonce / expired / over-TTL rejections happen before broadcast.
    const chainNonce = BigInt(await adapter.getNonce(pid));
    if (BigInt(dto.nonce) !== chainNonce) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "stale-nonce",
        new ConflictException("Authorization is stale — please try again (a newer nonce is active)"),
      );
    }
    const chainTime = await adapter.chainTime();
    if (dto.expiry <= chainTime) {
      return this.reject(pid, "execute", dto.nonce, "expired", new BadRequestException("Authorization expired — please try again"));
    }
    if (dto.expiry - chainTime > MAX_TTL_SECS) {
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "expired",
        new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"),
      );
    }

    // Attest the realtime network fee at submit time; fail closed when it drifted
    // beyond 120% of what the client quoted against.
    const quoted = BigInt(dto.quotedNetworkFeeLamports);
    const networkFee = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length);
    if (exceedsDriftBound(networkFee, quoted)) {
      await this.driftRejected(pid, "execute", quoted, networkFee);
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "drift",
        new ConflictException("Network fee moved — re-quote and try again"),
      );
    }
    const protocolFee = protocolFeeOf(networkFee, leg.bps);
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
      return this.reject(
        pid,
        "execute",
        dto.nonce,
        "insufficient-funds",
        new BadRequestException(`Insufficient SOL for fee — need ${totalFee} lamports, have ${smartSol}`),
      );
    }

    // Relayer float pre-check (same fail-fast as activation).
    const relayerBal = await adapter.getBalanceOf(this.relayer().publicKey.toBase58());
    const feeForTx = await adapter.estimateExecuteFee(decoded.target, decoded.metas, decoded.data.length).catch(() => 5000n);
    if (BigInt(relayerBal) < feeForTx) {
      // Service outage, not an intent rejection (closed H1.ii cause set).
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
          .sponsoredExecuteV4(
            pid,
            authorityCompressed,
            decoded.target,
            decoded.metas,
            decoded.data,
            version,
            networkFee,
            maxTotalFee,
            chainNonce,
            dto.expiry,
            assertion,
            this.relayer(),
            undefined,
          )
          .then((sig) => ({ signature: sig, result: null })),
      resolveState: () => this.resolveSvmState(adapter, pid, chain.address, chainNonce),
    });
    const signature = out.signature;
    if (!signature) {
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
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
      await this.security.log(pid, "execute.confirm_failed", {
        entryPoint: "execute",
        chain: BROADCAST_CHAIN_SOLANA,
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
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
    });
    if (status === "confirmed") {
      await this.security.log(pid, RelayerH1Events.resolveLanded, {
        chain: "solana",
        entryPoint: "execute",
        nonce: dto.nonce,
        signature,
      });
    }
    await this.reconcile(pid, adapter, signature, networkFee, protocolFee, leg, "execute").catch((err) =>
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
      ...(feePolicyWarning ? { feePolicyWarning } : {}),
    };
  }
}
