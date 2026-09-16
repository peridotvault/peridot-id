// Peridot-sponsored smart-account activation (state machine INACTIVATED → FUNDED → READY
// → ACTIVATING → ACTIVE, with INSUFFICIENT on shortfall). A Peridot relayer floats the
// rent + network fee; the smart account reimburses the attested network cost in full to
// the relayer plus the on-chain-recomputed protocol fee to the canonical revenue vault
// upon claiming. The user only ever uses one deterministic address.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChainAccount, ChainAccountStatus, TransactionStatus } from "@prisma/client";
import type { Keypair, PasskeyAssertion, PublicKey, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { classifyActivation, requireActiveAuthority } from "../common/activation";
import { ACCOUNT_TYPE_SMART, SOLANA_NAMESPACE } from "../common/chains";
import {
  feePolicyVersion as configuredPolicyVersion,
  protocolFeeBps,
  protocolFeeOf,
  exceedsDriftBound,
  relayerKeypair,
  solanaAdapter,
  solanaRpcUrl,
  treasuryPubkey,
} from "../common/solana-relay";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export type ActivationStatus = ChainAccountStatus;

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
  /** base64url sha256 of the WebAuthn RP ID (bound into the V3 activation payload). */
  rpIdHash: string;
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
  ) {}

  onModuleInit(): void {
    const intervalMs = Number(this.config.get<string>("PID_ACTIVATION_POLL_MS", "10000"));
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err) => this.logger.error(`poll error: ${(err as Error).message}`));
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private rpcUrl(): string {
    return solanaRpcUrl(this.config);
  }

  private policyVersion(): number {
    return configuredPolicyVersion(this.config);
  }

  /** sha256 of the WebAuthn RP ID — stored on-chain and verified per assertion. */
  private async rpIdHash(): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(this.config.get<string>("WEBAUTHN_RP_ID", "localhost")),
    );
    return new Uint8Array(digest);
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

  private adapter(): SolanaAdapter {
    return solanaAdapter(this.pidSolana, this.config);
  }

  /** Realtime activation network-cost estimate (rent + message fee, no margin)
   *  plus the protocol fee for the active policy. The protocol fee is a fixed
   *  percentage of the network cost — never a margin on a total. */
  private async quotedFees(adapter: SolanaAdapter): Promise<{
    networkEst: bigint;
    protocolFee: bigint;
    total: bigint;
    version: number;
    bps: number;
  }> {
    const cost = await adapter.estimateActivationCost(0);
    const networkEst = cost.rentLamports + cost.feeLamports;
    const version = this.policyVersion();
    const bps = protocolFeeBps(version);
    const protocolFee = protocolFeeOf(networkEst, bps);
    return { networkEst, protocolFee, total: networkEst + protocolFee, version, bps };
  }

  /** Active lamports held by the Peridot relayer (the float that funds fee + rent). */
  private async relayerBalanceLamports(): Promise<number> {
    const adapter = this.adapter();
    return adapter.getBalanceOf(this.relayer().publicKey.toBase58());
  }

  private confirmAttempts(): number {
    const n = Number(this.config.get<string>("PID_ACTIVATION_CONFIRM_ATTEMPTS", "15"));
    return Number.isFinite(n) && n > 0 ? n : 15;
  }

  private confirmIntervalMs(): number {
    const n = Number(this.config.get<string>("PID_ACTIVATION_CONFIRM_INTERVAL_MS", "1000"));
    return Number.isFinite(n) && n > 0 ? n : 1000;
  }

  /**
   * Confirm an activation. Chain state is authoritative: once the PDA is program-owned the
   * activation succeeded even if the optimistic signature query is slow on a public RPC.
   * Returns 'confirmed' (err?) or 'pending' when the window expires.
   */
  private async confirmActivation(
    sig: string,
    address: string,
  ): Promise<{ outcome: "confirmed" | "failed" | "pending"; reason?: string }> {
    const adapter = this.adapter();
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
    });
    if (pending.length === 0) return;

    const adapter = this.adapter();
    const quoted = await this.quotedFees(adapter);

    for (const ca of pending) {
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
   *  by the client (V3 payload binds op-tag, account, authority, RP-ID hash,
   *  policy, expiry — no amounts) — the relayer only submits, so a stranger can
   *  neither squat the PDA nor divert funds or change the fee policy. */
  async activate(
    user: { pid: string },
    dto: {
      expiry: number;
      feePolicyVersion: number;
      quotedNetworkFeeLamports: string;
      assertion: { id: string; signature: string; authenticatorData: string; clientDataJSON: string };
    },
  ): Promise<ActivationView> {
    const chain = await this.ownedSolanaRow(user.pid);

    if (chain.status === "active") return this.viewOf(user);

    // Re-derive live state so a stale stored status can't block a genuinely READY account.
    const adapter = this.adapter();
    let balance = 0;
    let activated = false;
    try {
      balance = await adapter.getBalanceOf(chain.address);
      activated = await adapter.isActivated(chain.address);
    } catch (err) {
      this.logger.warn(`activation check failed for ${chain.address}: ${(err as Error).message}`);
    }
    const quoted = await this.quotedFees(adapter);
    const required = Number(quoted.total);
    const live = activated ? "active" : this.classify(balance, required, chain.status);

    if (live === "active") return this.viewOf(user);

    if (live !== "ready") {
      throw new ConflictException(`Wallet must be READY to activate (currently ${live})`);
    }

    await requireActiveAuthority(this.prisma, user.pid);

    await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "activating" } });
    try {
      // The asserting credential must be one of this wallet's active passkeys, and the
      // ix authority must be THAT key (the payload is bound to the signer).
      const asserting = await this.prisma.authority.findFirst({
        where: { pid: user.pid, credentialId: dto.assertion.id, status: "active" },
      });
      if (!asserting) throw new BadRequestException("Unknown or inactive passkey");
      // Pre-check: Peridot's relayer floats the fee + rent. If it's out of SOL the tx would
      // be silently dropped (skipPreflight), so fail fast with a clear message instead.
      let relayerBalance = 0;
      try {
        relayerBalance = await this.relayerBalanceLamports();
      } catch (err) {
        this.logger.warn(`relayer balance check failed: ${(err as Error).message}`);
      }
      if (relayerBalance < required) {
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
        await this.security.log(user.pid, "account.activation.relayer_unfunded", { relayer: this.relayer().publicKey.toBase58() });
        throw new ServiceUnavailableException(
          "Peridot's activation service is temporarily out of funds. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }

      // Stale expiries are rejected before broadcast (the program enforces it too),
      // as are lifetimes beyond the cross-cluster replay bound.
      const chainTime = await adapter.chainTime().catch(() => 0);
      if (dto.expiry <= chainTime) throw new BadRequestException("Authorization expired — please try again");
      if (dto.expiry - chainTime > MAX_TTL_SECS) {
        throw new BadRequestException("Authorization lifetime exceeds 600 seconds — re-quote and try again");
      }
      if (dto.feePolicyVersion !== quoted.version) {
        throw new BadRequestException("Unsupported fee policy — re-quote and try again");
      }
      // Attest the realtime network fee at submit time; fail closed when it drifted
      // beyond 120% of what the client quoted against.
      const quotedNetwork = BigInt(dto.quotedNetworkFeeLamports);
      const submitCost = await adapter.estimateActivationCost(0);
      const networkFee = submitCost.rentLamports + submitCost.feeLamports;
      if (exceedsDriftBound(networkFee, quotedNetwork)) {
        throw new ConflictException("Network fee moved — re-quote and try again");
      }
      const protocolFee = protocolFeeOf(networkFee, quoted.bps);

      const signature = await adapter.activateV3(
        user.pid,
        coseToCompressedSecp256r1(Buffer.from(asserting.publicKey)) as unknown as Uint8Array<ArrayBufferLike>,
        await this.rpIdHash(),
        quoted.version,
        networkFee,
        dto.expiry,
        this.relayer(),
        this.treasury(),
        this.toAssertion(dto.assertion),
      );

      const { outcome, reason } = await this.confirmActivation(signature, chain.address);
      if (outcome !== "confirmed") {
        // Revert — the transaction never landed (or errored); the user's deposit is untouched.
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
        await this.security.log(user.pid, "account.activation.unconfirmed", { signature, outcome, reason });
        throw new ServiceUnavailableException(
          outcome === "failed"
            ? `Activation was submitted but failed on-chain${reason ? ` (${shortReason(reason)})` : ""}. No SOL was deducted from your wallet — please try again.`
            : "Activation was submitted but not confirmed on-chain yet. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }

      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "active" } });
      // Activity history: account creation + exact network-cost reimbursement to the
      // relayer and the protocol fee to the revenue vault (split enforced on-chain).
      const totalFee = networkFee + protocolFee;
      await this.prisma.transaction
        .create({
          data: {
            pid: user.pid,
            chainAccountId: chain.id,
            type: "ACTIVATION",
            amount: BigInt(totalFee),
            asset: "SOL",
            direction: "out",
            counterparty: this.treasury().toBase58(),
            chain: "solana",
            network: this.config.get<string>("SOLANA_NETWORK", "devnet"),
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
        feePolicyVersion: quoted.version,
      });
      await this.reconcileActivation(user.pid, adapter, signature, networkFee, protocolFee, quoted.version).catch(
        (err) => this.logger.warn(`activation reconcile failed for ${signature}: ${(err as Error).message}`),
      );
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }

    return this.viewOf(user);
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
  async viewOf(user: { pid: string }): Promise<ActivationView> {
    const chain = await this.ownedSolanaRow(user.pid);
    const adapter = this.adapter();
    let balance = 0;
    let activated = false;
    try {
      balance = await adapter.getBalanceOf(chain.address);
      activated = await adapter.isActivated(chain.address);
    } catch (err) {
      this.logger.warn(`activation view failed for ${chain.address}: ${(err as Error).message}`);
    }
    const quoted = await this.quotedFees(adapter);
    const required = Number(quoted.total);

    // Authoritative: a program-owned PDA is ACTIVE regardless of stored status.
    // (Safe: program-owned state can only be created through this program's
    // passkey-gated creators — unlike EVM code-presence, ownership is proof.)
    const status: ChainAccountStatus = activated
      ? "active"
      : this.classify(balance, required, chain.status);

    return {
      pid: user.pid,
      status,
      smartAccountAddress: chain.address,
      balanceLamports: balance,
      requiredLamports: required,
      networkFeeLamports: Number(quoted.networkEst),
      protocolFeeBps: quoted.bps,
      chainTime: await adapter.chainTime().catch(() => 0),
      treasury: this.treasury().toBase58(),
      feePolicyVersion: quoted.version,
      rpIdHash: Buffer.from(await this.rpIdHash()).toString("base64url"),
    };
  }

  /**
   * Post-confirmation reconciliation for activation: verify the program applied
   * the canonical formula. Rent stays locked in the PDA (not paid to anyone),
   * so only the fee split is checked here.
   */
  private async reconcileActivation(
    pid: string,
    adapter: SolanaAdapter,
    signature: string,
    networkFee: bigint,
    protocolFee: bigint,
    version: number,
  ): Promise<void> {
    const expectedProtocol = protocolFeeOf(networkFee, protocolFeeBps(version));
    await this.security.log(pid, "account.activation.reconciled", {
      signature,
      networkFee: networkFee.toString(),
      protocolFee: protocolFee.toString(),
      protocolFeeExpected: expectedProtocol.toString(),
    });
    if (protocolFee !== expectedProtocol) {
      this.logger.error(
        `activation formula anomaly: ${signature} protocol=${protocolFee} expected=${expectedProtocol}`,
      );
    }
  }

  /** Solana smart row owned by the token identity — never a client-supplied one. */
  private async ownedSolanaRow(pid: string) {
    const chain = await this.prisma.chainAccount.findFirst({
      where: { chain: { namespace: SOLANA_NAMESPACE }, accountType: POLL_ACCOUNT_TYPE, pid },
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

