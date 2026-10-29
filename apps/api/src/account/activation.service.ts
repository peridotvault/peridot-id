// Peridot-sponsored smart-account activation (state machine INACTIVATED → FUNDED → READY
// → ACTIVATING → ACTIVE, with INSUFFICIENT on shortfall). A Peridot relayer floats the
// rent + network fee; the smart account reimburses the attested network cost in full to
// the relayer plus the on-chain-recomputed protocol fee to the canonical revenue vault
// upon claiming. The user only ever uses one deterministic address.

import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccount, ChainAccountStatus, TransactionStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { classifyActivation, requireActiveAuthority } from "../common/activation";
import { ACCOUNT_TYPE_SMART, SOLANA_DEVNET_REFERENCE, SOLANA_NAMESPACE, SOLANA_TESTNET_REFERENCE, SolanaSelection, solanaReferenceFor } from "../common/chains";
import { ChainRegistryService } from "../chain/chain-registry.service";
import {
  exceedsMaxTotalFee,
  feePolicyVersion as configuredPolicyVersion,
  protocolFeeBps,
  protocolFeeOf,
  exceedsDriftBound,
  QUOTE_TTL_SECS,
  relayerKeypair,
  solanaAdapter,
} from "../common/solana-relay";
import { FeePolicyService } from "../fee/fee-policy.service";
import { PID_ACTIVATION_CONFIRM_INTERVAL_MS, PID_ACTIVATION_CONFIRM_ATTEMPTS, PID_ACTIVATION_POLL_MS } from "../common/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CircuitBreakerService } from "../relayer/circuit-breaker.service";
import {
  BROADCAST_CHAIN_SOLANA,
  RelayerIdempotencyService,
} from "../relayer/relayer-idempotency.service";
import { IntentRejectionCause, RelayerH1Events, absorbedLoss, fmtBaseUnits } from "../relayer/relayer-events";

export type ActivationStatus = ChainAccountStatus;

export interface ChainEcho {
  namespace: "solana";
  reference: string;
}

export interface ActivationView {
  pid: string;
  status: ActivationStatus;
  smartAccountAddress: string;
  balanceLamports: number;
  requiredLamports: number;
  /** Realtime network-cost estimate the backend will attest near (lamports). */
  networkFeeLamports: number;
  /** Fixed protocol percentage in bps for the quoted policy version. */
  protocolFeeBps: number;
  /** Chain time (unix seconds) for the activation challenge expiry. */
  chainTime: number;
  /** Canonical revenue vault (informational — enforced on-chain). */
  treasury: string;
  /** Fee-policy version the quote was computed under (client must sign this). */
  feePolicyVersion: number;
  /** Additive CAIP-2 echo of the active Solana chain (omitted when registry has none). */
  chain?: ChainEcho;
  // --- Fee-policy v2 canonical quote fields (ANT-544 §4.1) ---
  /** Canonical alias of networkFeeLamports (base units, decimal string). */
  networkFee: string;
  /** platform fee: floor(networkFee×bps/10_000), pure percentage (base units). */
  platformFee: string;
  /** networkFee + platformFee at quote time (canonical). */
  totalFee: string;
  /** Offered user-approved upper bound for the V4 authorization (defaults to totalFee). */
  maxTotalFee: string;
  /** minima leg — always "0" since ANT-743 (kept for shape compatibility). */
  chainMinBaseUnits: string;
  /** Quote timestamps (ISO-8601; `expiresAt − quotedAt` ≤ 300s, NFR-3). */
  quotedAt: string;
  expiresAt: string;
  /** Present on submit results when the signed version trails the active policy by one (NFR-6). */
  feePolicyWarning?: string;
}

const POLL_ACCOUNT_TYPE = ACCOUNT_TYPE_SMART;

/** Maximum authorization lifetime (seconds) — bounds cross-cluster replay. */
const MAX_TTL_SECS = 600;

@Injectable()
export class ActivationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly chains: ChainRegistryService,
    private readonly idempotency: RelayerIdempotencyService,
    private readonly breaker: CircuitBreakerService,
    @Optional() private readonly fees?: FeePolicyService,
  ) {}

  onModuleInit(): void {
    const intervalMs = PID_ACTIVATION_POLL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => this.logger.error(`poll error: ${(err as Error).message}`));
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private policyVersion(): number {
    return configuredPolicyVersion();
  }

  /** Activity label for the selected chain (default = current behavior). */
  private async networkLabel(selection?: SolanaSelection): Promise<string> {
    return this.chains.networkLabel(selection);
  }

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    return relayerKeypair(this.pidSolana, this.config);
  }

  private async adapter(selection?: SolanaSelection): Promise<SolanaAdapter> {
    const [rpcUrl, programId] = await Promise.all([this.chains.solanaRpcUrl(selection), this.chains.solanaProgramId(selection)]);
    return solanaAdapter(this.pidSolana, rpcUrl, programId);
  }

  /** Selection for a registry reference (undefined when unmapped — the poll
   *  grouping skips-and-alerts on those rows fail-closed instead of quoting
   *  them against the default cluster). */
  private selectionForReference(reference: string): SolanaSelection | undefined {
    if (reference === SOLANA_TESTNET_REFERENCE) return "testnet";
    if (reference === SOLANA_DEVNET_REFERENCE) return "devnet";
    return undefined;
  }

  /** Quoting leg for one Solana cluster (ANT-743: pure percentage — the
   *  fee-policy service supplies version + bps; the minima leg is always 0).
   *  Frozen in-code bps apply when the service/row is absent. */
  private async solanaFeeLeg(
    selection?: SolanaSelection,
    version?: number,
  ): Promise<{ version: number; bps: number; chainMin: bigint }> {
    const reference = solanaReferenceFor(selection ?? "devnet");
    if (this.fees) {
      if (version === undefined) {
        const m = await this.fees.minFeeFor(SOLANA_NAMESPACE, reference);
        return { version: m.version, bps: m.bps, chainMin: 0n };
      }
      const leg = await this.fees.minFeeForVersion(SOLANA_NAMESPACE, reference, version).catch(() => undefined);
      if (leg) return { version, bps: leg.bps, chainMin: 0n };
    }
    const v = version ?? this.policyVersion();
    return { version: v, bps: protocolFeeBps(v), chainMin: 0n };
  }

  /** Realtime activation network-cost estimate (rent + message fee, no margin)
   *  plus the platform fee for the active policy (pure 50% — never a margin
   *  on a total). */
  private async quotedFees(
    adapter: SolanaAdapter,
    selection?: SolanaSelection,
  ): Promise<{
    networkEst: bigint;
    protocolFee: bigint;
    total: bigint;
    version: number;
    bps: number;
    chainMin: bigint;
  }> {
    const cost = await adapter.estimateActivationCost(0);
    const networkEst = cost.rentLamports + cost.feeLamports;
    const leg = await this.solanaFeeLeg(selection);
    const protocolFee = protocolFeeOf(networkEst, leg.bps);
    return { networkEst, protocolFee, total: networkEst + protocolFee, version: leg.version, bps: leg.bps, chainMin: leg.chainMin };
  }

  /** Active lamports held by the Peridot relayer (the float that funds fee + rent). */
  private async relayerBalanceLamports(selection?: SolanaSelection): Promise<number> {
    const adapter = await this.adapter(selection);
    return adapter.getBalanceOf(this.relayer().publicKey.toBase58());
  }

  private confirmAttempts(): number {
    return PID_ACTIVATION_CONFIRM_ATTEMPTS;
  }

  private confirmIntervalMs(): number {
    const n = PID_ACTIVATION_CONFIRM_INTERVAL_MS;
    return Number.isFinite(n) && n > 0 ? n : PID_ACTIVATION_CONFIRM_INTERVAL_MS;
  }

  /**
   * Confirm an activation. Chain state is authoritative: once the PDA is program-owned the
   * activation succeeded even if the optimistic signature query is slow on a public RPC.
   * Returns 'confirmed' (err?) or 'pending' when the window expires.
   */
  private async confirmActivation(
    sig: string,
    address: string,
    selection?: SolanaSelection,
  ): Promise<{ outcome: "confirmed" | "failed" | "pending"; reason?: string }> {
    const adapter = await this.adapter(selection);
    const attempts = this.confirmAttempts();
    const intervalMs = this.confirmIntervalMs();
    for (let i = 0; i < attempts; i++) {
      if (await adapter.isActivated(address)) return { outcome: "confirmed" };
      try {
        const status = await adapter.getStatus(sig);
        if (status.confirmed) {
          if (status.error) return { outcome: "failed", reason: status.error };
          return { outcome: "confirmed" };
        }
      } catch {
        // transient RPC error — keep polling
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (await adapter.isActivated(address).catch(() => false)) return { outcome: "confirmed" };
    return { outcome: "pending" };
  }

  /** Poll on-chain balances for pending accounts and advance their state machine. */
  async poll(): Promise<void> {
    const pending = await this.prisma.chainAccount.findMany({
      where: {
        // Solana rows only — eip155 rows are polled by EvmActivationService.
        chain: { namespace: SOLANA_NAMESPACE },
        accountType: POLL_ACCOUNT_TYPE,
        status: { in: ["inactivated", "funded", "insufficient", "ready", "activating", "active"] },
      },
      include: { chain: true },
    });
    if (pending.length === 0) return;

    // Group by chain so every row is read and quoted against its own cluster
    // + program (devnet/testnet). Single-chain DBs behave exactly as before.
    const byChain = new Map<string, { reference: string; rows: typeof pending }>();
    for (const ca of pending) {
      const group = byChain.get(ca.chainId) ?? { reference: ca.chain.reference, rows: [] };
      group.rows.push(ca);
      byChain.set(ca.chainId, group);
    }

    for (const group of byChain.values()) {
      const selection = this.selectionForReference(group.reference);
      if (!selection) {
        // Fail closed on unmapped rows (e.g. a future third Solana row): never
        // quote them against the default cluster. Skip the group and alert so
        // operators notice the unmapped row instead of silently misquoting it.
        this.logger.warn(
          `activation poll skipping ${group.rows.length} row(s) with unmapped solana reference "${group.reference}"`,
        );
        for (const ca of group.rows) {
          try {
            await this.security.log(ca.pid, "account.activation.unmapped_chain", {
              reference: group.reference,
            });
          } catch (err) {
            this.logger.warn(`activation poll alert failed for ${ca.address}: ${(err as Error).message}`);
          }
        }
        continue;
      }
      const adapter = await this.adapter(selection);
      const quoted = await this.quotedFees(adapter, selection);

      for (const ca of group.rows) {
        try {
          const activated = await adapter.isActivated(ca.address);
          if (activated && ca.status !== "active") {
            // The PDA became program-owned outside this poll's bookkeeping (e.g. a confirm
            // timed out but the tx landed). Heal the row to match on-chain truth.
            await this.prisma.chainAccount.update({
              where: { id: ca.id },
              data: { status: "active" },
            });
            await this.security.log(ca.pid, "account.activation.promoted", { from: ca.status, to: "active" });
            continue;
          }
          if (ca.status === "active") {
            // stale active row on-chain not actually activated (e.g. earlier dropped tx)
            if (activated) continue;
            await this.prisma.chainAccount.update({
              where: { id: ca.id },
              data: { status: "inactivated", activationBalance: null, activationRequired: null },
            });
            await this.security.log(ca.pid, "account.activation.healed", { from: "active", to: "inactivated" });
            continue;
          }

          const balance = await adapter.getBalanceOf(ca.address);
          const required = Number(quoted.total);
          const next = this.classify(balance, required, ca.status);
          await this.prisma.chainAccount.update({
            where: { id: ca.id },
            data: { status: next, activationBalance: BigInt(balance), activationRequired: BigInt(required) },
          });
          await this.security.log(ca.pid, "account.activation.polled", { status: next, balance });
        } catch (err) {
          this.logger.warn(`activation poll failed for ${ca.address}: ${(err as Error).message}`);
        }
      }
    }

    // Orphaned activity rows: an ACTIVATION tx that never got confirmed is a failed attempt —
    // no funds moved, the account reverted. Mark it failed so the activity history is truthful.
    await this.prisma.transaction
      .updateMany({
        where: { type: "ACTIVATION", status: "submitted" },
        data: { status: "failed" as TransactionStatus },
      })
      .catch((err) => this.logger.warn(`activation tx cleanup failed: ${(err as Error).message}`));
  }

  private classify(balance: number, required: number, current: ChainAccountStatus): ChainAccountStatus {
    return classifyActivation(balance, required, current);
  }

  /** Activate a READY wallet (idempotent once ACTIVE). The claim is passkey-signed
   *  by the client (V4 payload binds op-tag, account, authority, policy,
   *  maxTotalFee, expiry) — the relayer only submits, so a stranger can
   *  neither squat the PDA nor divert funds or change the fee policy. V3
   *  broadcasts are closed (ANT-895/B2: the program rejects them with
   *  V3Deprecated) — this path only broadcasts activateV4. */
  async activate(
    user: { pid: string },
    dto: {
      expiry: number;
      feePolicyVersion: number;
      quotedNetworkFeeLamports: string;
      /**
       * User-approved upper bound on `networkFee + platformFee` carried by the
       * passkey-signed V4 authorization (spec B5). Required — no silent default;
       * enforced pre-broadcast, fail-closed (re-quote).
       */
      maxTotalFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
    selection?: SolanaSelection,
  ): Promise<ActivationView> {
    const chain = await this.ownedSolanaRow(user.pid, selection);

    if (chain.status === "active") return this.viewOf(user, selection);

    // Re-derive live state so a stale stored status can't block a genuinely READY account.
    const adapter = await this.adapter(selection);
    let balance = 0;
    let activated = false;
    try {
      balance = await adapter.getBalanceOf(chain.address);
      activated = await adapter.isActivated(chain.address);
    } catch (err) {
      this.logger.warn(`activation check failed for ${chain.address}: ${(err as Error).message}`);
    }
    const quoted = await this.quotedFees(adapter, selection);
    const required = Number(quoted.total);
    const live = activated ? "active" : this.classify(balance, required, chain.status);

    if (live === "active") return this.viewOf(user, selection);

    if (live !== "ready") {
      throw new ConflictException(`Wallet must be READY to activate (currently ${live})`);
    }

    // H3: fail-closed while the per-chain spend-rate breaker is open.
    await this.breaker.requireClosed(BROADCAST_CHAIN_SOLANA, "activate");

    await requireActiveAuthority(this.prisma, user.pid);

    await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "activating" } });
    try {
      // The asserting credential must be one of this wallet's active passkeys, and the
      // ix authority must be THAT key (the payload is bound to the signer).
      const asserting = await this.prisma.authority.findFirst({
        where: { pid: user.pid, credentialId: dto.assertion.id, status: "active" },
      });
      if (!asserting) {
        return this.reject(user.pid, "unauthorized", new BadRequestException("Unknown or inactive passkey"));
      }
      // B1 (ANT-866): the claim target is the bound PDA of the ASSERTING key
      // (claim-time binding). Heal pre-binding rows so funding/verification
      // land on the only address this key can claim.
      const assertingKey = coseToCompressedSecp256r1(Buffer.from(asserting.publicKey));
      const programId = await this.chains.solanaProgramId(selection);
      const boundAddress = this.pidSolana.deriveSmartAccountAddress(
        user.pid,
        new Uint8Array(assertingKey),
        new this.pidSolana.PublicKey(programId),
      ).address.toBase58();
      if (chain.address !== boundAddress) {
        this.logger.warn(`svm address heal for ${user.pid}: ${chain.address} → ${boundAddress} (B1 binding)`);
        await this.prisma.chainAccount.update({
          where: { id: chain.id },
          data: {
            address: boundAddress,
            activationBalance: null,
            activationRequired: null,
            // ANT-866/F1: the asserting key IS the claiming key by definition
            // (the claim about to be broadcast commits to it). All later
            // derivation reads this recorded key — never oldest-active.
            claimAuthority: Buffer.from(assertingKey),
          },
        });
        chain.address = boundAddress;
      }
      // Pre-check: Peridot's relayer floats the fee + rent. If it's out of SOL the tx would
      // be silently dropped (skipPreflight), so fail fast with a clear message instead.
      let relayerBalance = 0;
      try {
        relayerBalance = await this.relayerBalanceLamports(selection);
      } catch (err) {
        this.logger.warn(`relayer balance check failed: ${(err as Error).message}`);
      }
      if (relayerBalance < required) {
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
        // Service outage, not an intent rejection: no intent.rejected row (the
        // H1.ii cause set is closed and has no service-side cause). The legacy
        // row + 503 below preserve the alert trail.
        await this.security.log(user.pid, "account.activation.relayer_unfunded", { relayer: this.relayer().publicKey.toBase58() });
        throw new ServiceUnavailableException(
          "Peridot's activation service is temporarily out of funds. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }

      // Stale expiries are rejected before broadcast (the program enforces it too),
      // as are lifetimes beyond the cross-cluster replay bound.
      const chainTime = await adapter.chainTime().catch(() => 0);
      if (dto.expiry <= chainTime) {
        return this.reject(user.pid, "expired", new BadRequestException("Authorization expired — please try again"));
      }
      if (dto.expiry - chainTime > MAX_TTL_SECS) {
        return this.reject(user.pid, "expired", new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again"));
      }
      // Submit settles under the SIGNED version (spec §4.3/NFR-6): the active
      // version and one version back are accepted (older with a warning); older
      // is StaleQuote (410), unknown is UnknownFeePolicy (400).
      const version = dto.feePolicyVersion;
      let feePolicyWarning: string | undefined;
      if (this.fees) {
        const gate = await this.fees.checkSubmitVersion(version);
        if (!gate.ok) {
          return this.reject(
            user.pid,
            "policy-unknown",
            gate.status === 410
              ? new GoneException({ code: gate.code, message: gate.message })
              : new BadRequestException({ code: gate.code, message: gate.message }),
          );
        }
        feePolicyWarning = gate.warning;
      } else if (version !== quoted.version) {
        return this.reject(user.pid, "policy-unknown", new BadRequestException("Unsupported fee policy — re-quote and try again"));
      }
      const submitLeg = await this.solanaFeeLeg(selection, version);
      // Attest the realtime network fee at submit time; fail closed when it drifted
      // beyond 120% of what the client quoted against.
      const quotedNetwork = BigInt(dto.quotedNetworkFeeLamports);
      const submitCost = await adapter.estimateActivationCost(0);
      const networkFee = submitCost.rentLamports + submitCost.feeLamports;
      if (exceedsDriftBound(networkFee, quotedNetwork)) {
        await this.security.log(user.pid, RelayerH1Events.driftRejected, {
          chain: "solana",
          entryPoint: "activate",
          quoted: fmtBaseUnits(quotedNetwork),
          attested: fmtBaseUnits(networkFee),
        });
        return this.reject(user.pid, "drift", new ConflictException("Network fee moved — re-quote and try again"));
      }
      const protocolFee = protocolFeeOf(networkFee, submitLeg.bps);
      const totalFee = networkFee + protocolFee;

      // V4 user bound (spec B5/B-AC5): `totalFee ≤ maxTotalFee` pre-broadcast.
      if (!/^\d+$/.test(dto.maxTotalFeeLamports)) {
        throw new BadRequestException("Max total fee must be a positive integer");
      }
      if (exceedsMaxTotalFee(totalFee, BigInt(dto.maxTotalFeeLamports))) {
        await this.security.log(user.pid, "account.activation.max_total_exceeded", {
          totalFee: totalFee.toString(),
          maxTotalFee: dto.maxTotalFeeLamports,
          networkFee: networkFee.toString(),
          protocolFee: protocolFee.toString(),
          feePolicyVersion: version,
        });
        throw new ConflictException("Total fee exceeds your authorized maximum — re-quote and try again");
      }

      // H2: claim the (pid, expiry, chain) slot — the expiry is the
      // replay-protection scalar for activation. Identical retries reuse the
      // slot; different bytes under the same expiry are forbidden.
      const slotHash = createHash("sha256")
        .update(JSON.stringify(["activate", dto.expiry, version, networkFee.toString()]))
        .update(dto.assertion.signature)
        .digest("hex");
      const claim = await this.idempotency.claimSlot(
        user.pid,
        String(dto.expiry),
        BROADCAST_CHAIN_SOLANA,
        slotHash,
        "activate",
      );
      if (claim.decision === "duplicate" && claim.signature) {
        const dup = await this.viewOf(user, selection);
        return feePolicyWarning ? { ...dup, feePolicyWarning } : dup;
      }

      const out = await this.idempotency.broadcastWithResolveThenAct({
        pid: user.pid,
        nonce: String(dto.expiry),
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "activate",
        broadcast: () =>
          adapter
            .activateV4(
              user.pid,
              coseToCompressedSecp256r1(Buffer.from(asserting.publicKey)) as unknown as Uint8Array<ArrayBufferLike>,
              version,
              networkFee,
              BigInt(dto.maxTotalFeeLamports),
              dto.expiry,
              this.relayer(),
              undefined,
              this.toAssertion(dto.assertion),
            )
            .then((sig) => ({ signature: sig, result: null })),
        resolveState: async () => {
          const activated = await adapter.isActivated(chain.address).catch(() => null);
          if (activated == null) return { unreadable: true as const };
          return activated
            ? { landed: true as const, signature: claim.signature }
            : { landed: false as const };
        },
      });
      const signature = out.signature;
      if (!signature) {
        // Proven landed (account active) but receipt unattributed: chain state
        // IS the confirmation. Record active, alert for the missing receipt.
        await this.idempotency.recordOutcome(
          user.pid,
          String(dto.expiry),
          BROADCAST_CHAIN_SOLANA,
          "activate",
          "resolved-landed",
        );
        await this.security.log(user.pid, RelayerH1Events.resolveLanded, {
          entryPoint: "activate",
          chain: BROADCAST_CHAIN_SOLANA,
          unattributed: true,
        });
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "active" } });
        return this.viewOf(user, selection);
      }

      const { outcome, reason } = await this.confirmActivation(signature, chain.address, selection);
      if (outcome !== "confirmed") {
        // Revert — the transaction never landed (or errored); the user's deposit is untouched.
        // Post-confirmation failure alerts, never rebroadcasts (H2.iii).
        await this.idempotency.recordOutcome(
          user.pid,
          String(dto.expiry),
          BROADCAST_CHAIN_SOLANA,
          "activate",
          outcome === "failed" ? "failed" : "submitted",
          signature,
        );
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
        await this.security.log(user.pid, "account.activation.unconfirmed", { signature, outcome, reason });
        throw new ServiceUnavailableException(
          outcome === "failed"
            ? `Activation was submitted but failed on-chain${reason ? ` (${shortReason(reason)})` : ""}. No SOL was deducted from your wallet — please try again.`
            : "Activation was submitted but not confirmed on-chain yet. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }
      await this.idempotency.recordOutcome(
        user.pid,
        String(dto.expiry),
        BROADCAST_CHAIN_SOLANA,
        "activate",
        "confirmed",
        signature,
      );

      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "active" } });
      // Activity history: account creation + exact network-cost reimbursement to the
      // relayer and the protocol fee to the revenue vault (split enforced on-chain).
      await this.prisma.transaction
        .create({
          data: {
            pid: user.pid,
            chainAccountId: chain.id,
            type: "ACTIVATION",
            amount: BigInt(totalFee),
            asset: "SOL",
            direction: "out",
            counterparty: adapter.treasuryAddress().toBase58(),
            chain: "solana",
            network: await this.networkLabel(selection),
            txHash: signature,
            status: "confirmed" as TransactionStatus,
            confirmedAt: new Date(),
          },
        })
        .catch((err) => this.logger.warn(`activation activity record failed: ${(err as Error).message}`));
      await this.security.log(user.pid, "account.activated", {
        signature,
        networkFee: networkFee.toString(),
        protocolFee: protocolFee.toString(),
        feePolicyVersion: version,
        ...(feePolicyWarning ? { feePolicyWarning } : {}),
      });
      // H2: resolve-then-act outcome for the sponsored activation.
      await this.security.log(user.pid, RelayerH1Events.resolveLanded, {
        chain: "solana",
        entryPoint: "activate",
        signature,
      });
      await this.reconcileActivation(user.pid, adapter, signature, networkFee, protocolFee, submitLeg).catch(
        (err) => this.logger.warn(`activation reconcile failed for ${signature}: ${(err as Error).message}`),
      );
      // NFR-4/AC-13: every activation lands a quote–actual pair in the subsidy
      // ledger. actualCost is the parsed tx fee (rent locks in the PDA and the
      // service leg is revenue, so subsidy reads negative by those legs —
      // the pair's job is drift visibility, not P&L exactness). Best-effort:
      // a ledger write failure never fails the user flow.
      await adapter
        .parseTransaction(signature)
        .then((parsed) => (parsed?.fee != null ? BigInt(parsed.fee) : null))
        .catch(() => null)
        .then((actual) => {
          if (actual === null) return undefined;
          return this.fees?.recordSubsidy({
            pid: user.pid,
            namespace: SOLANA_NAMESPACE,
            reference: solanaReferenceFor(selection ?? "devnet"),
            kind: "activation",
            quotedFee: networkFee + protocolFee,
            actualCost: actual,
            txHash: signature,
          });
        })
        .catch((err) => this.logger.warn(`activation subsidy ledger failed for ${signature}: ${(err as Error).message}`));
      const view = await this.viewOf(user, selection);
      return feePolicyWarning ? { ...view, feePolicyWarning } : view;
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }
  }

  /** H1.ii: semantic intent rejections emit intent.rejected (activation has no nonce — key omitted). */
  private async reject(pid: string, cause: IntentRejectionCause, err: Error): Promise<never> {
    await this.security.log(pid, RelayerH1Events.intentRejected, {
      chain: "solana",
      entryPoint: "activate",
      cause,
    });
    throw err;
  }

  /** Decode a client assertion DTO into chain bytes (mirrors SponsoredWithdrawService). */  private toAssertion(dto: {
    id: string;
    signature: string;
    authenticatorData: string;
    clientDataJSON: string;
  }): PasskeyAssertion {
    const { b64urlToBytes } = this.pidSolana;
    return {
      credentialId: dto.id,
      signature: b64urlToBytes(dto.signature) as unknown as Uint8Array<ArrayBufferLike>,
      authenticatorData: b64urlToBytes(dto.authenticatorData) as unknown as Uint8Array<ArrayBufferLike>,
      clientDataJSON: b64urlToBytes(dto.clientDataJSON) as unknown as Uint8Array<ArrayBufferLike>,
    };
  }

  /** Activation view derived live from on-chain state (ownership-checked). */
  async viewOf(user: { pid: string }, selection?: SolanaSelection): Promise<ActivationView> {
    const chain = await this.ownedSolanaRow(user.pid, selection);
    const adapter = await this.adapter(selection);
    let balance = 0;
    let activated = false;
    try {
      balance = await adapter.getBalanceOf(chain.address);
      activated = await adapter.isActivated(chain.address);
    } catch (err) {
      this.logger.warn(`activation view failed for ${chain.address}: ${(err as Error).message}`);
    }
    const quoted = await this.quotedFees(adapter, selection);
    const required = Number(quoted.total);

    // Authoritative: a program-owned PDA is ACTIVE regardless of stored status.
    // (Safe: program-owned state can only be created through this program's
    // passkey-gated creators — unlike EVM code-presence, ownership is proof.)
    const status: ChainAccountStatus = activated
      ? "active"
      : this.classify(balance, required, chain.status);

    const solChain = await this.chains.solanaChain(selection).catch(() => undefined);
    const chainTime = await adapter.chainTime().catch(() => 0);
    const quotedAt = new Date(chainTime * 1000);
    const expiresAt = new Date(quotedAt.getTime() + QUOTE_TTL_SECS * 1000);

    return {
      pid: user.pid,
      status,
      smartAccountAddress: chain.address,
      balanceLamports: balance,
      requiredLamports: required,
      networkFeeLamports: Number(quoted.networkEst),
      protocolFeeBps: quoted.bps,
      chainTime,
      treasury: adapter.treasuryAddress().toBase58(),
      feePolicyVersion: quoted.version,
      ...(solChain ? { chain: { namespace: "solana" as const, reference: solChain.reference } } : {}),
      networkFee: quoted.networkEst.toString(),
      platformFee: quoted.protocolFee.toString(),
      totalFee: quoted.total.toString(),
      maxTotalFee: quoted.total.toString(),
      chainMinBaseUnits: quoted.chainMin.toString(),
      quotedAt: quotedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Post-confirmation reconciliation for activation: verify the program applied
   * the canonical v2 formula. Rent stays locked in the PDA (not paid to anyone),
   * so only the fee split is checked here. Divergence fires a security event.
   */
  private async reconcileActivation(
    pid: string,
    adapter: SolanaAdapter,
    signature: string,
    networkFee: bigint,
    protocolFee: bigint,
    leg: { version: number; bps: number; chainMin: bigint },
  ): Promise<void> {
    const expectedProtocol = protocolFeeOf(networkFee, leg.bps);
    const formulaDiverged = protocolFee !== expectedProtocol;
    const parsed = await adapter.parseTransaction(signature).catch(() => null);
    const actual = parsed?.fee != null ? BigInt(parsed.fee) : null;
    const absorbed = absorbedLoss(networkFee, actual);
    await this.security.log(pid, "account.activation.reconciled", {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
      actualNetworkFee: actual?.toString() ?? "unknown",
      relayerAbsorbed: absorbed.toString(),
      formulaDiverged,
    });
    await this.security.log(pid, RelayerH1Events.pnl, {
      chain: BROADCAST_CHAIN_SOLANA,
      entryPoint: "activate",
      signature,
      absorbed: absorbed.toString(),
      attested: networkFee.toString(),
      actual: actual?.toString() ?? "unknown",
    });
    await this.breaker.recordAbsorbed(pid, BROADCAST_CHAIN_SOLANA, absorbed).catch((err) =>
      this.logger.warn(`breaker record failed: ${(err as Error).message}`),
    );
    if (formulaDiverged) {
      await this.security.log(pid, RelayerH1Events.formulaMismatch, {
        chain: BROADCAST_CHAIN_SOLANA,
        entryPoint: "activate",
        signature,
        attested: networkFee.toString(),
        actual: actual?.toString() ?? "unknown",
        expected: expectedProtocol.toString(),
        absorbed: absorbed.toString(),
      });
      this.logger.error(
        `activation formula anomaly: ${signature} protocol=${protocolFee} expected=${expectedProtocol}`,
      );
      await this.security.log(pid, "account.activation.fee_divergence", {
        signature,
        protocolFee: protocolFee.toString(),
        protocolFeeExpected: expectedProtocol.toString(),
        networkFee: networkFee.toString(),
        feePolicyVersion: leg.version,
      });
    }
  }

  /** Solana smart row owned by the token identity — never a client-supplied one. */
  private async ownedSolanaRow(pid: string, selection?: SolanaSelection) {
    const chain = await this.prisma.chainAccount.findFirst({
      where: {
        chain: {
          namespace: SOLANA_NAMESPACE,
          ...(selection ? { reference: solanaReferenceFor(selection) } : {}),
        },
        accountType: POLL_ACCOUNT_TYPE,
        pid,
      },
    });
    if (!chain) {
      throw new NotFoundException("Account not found");
    }
    return chain;
  }
}

/** Compact on-chain error for the UI — the full payload stays in the security log. */
function shortReason(err: string): string {
  const cleaned = err.trim();
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}…`;
}

