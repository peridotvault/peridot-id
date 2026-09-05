// Peridot-sponsored smart-account activation (state machine INACTIVATED → FUNDED → READY
// → ACTIVATING → ACTIVE, with INSUFFICIENT on shortfall). A Peridot relayer floats the
// rent + network fee; the contract transfers the activation fee (rent + fee + margin)
// from the user's smart account to the Peridot treasury upon claiming. The user only ever
// uses one deterministic address.

import {
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
import type { Keypair, PublicKey, SolanaAdapter, SolanaRpc } from "@peridotvault/pid-solana";
import { coseToCompressedSecp256r1 } from "../credentials/cose";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

export type ActivationStatus = ChainAccountStatus;

export interface ActivationView {
  accountId: string;
  status: ActivationStatus;
  smartAccountAddress: string;
  balanceLamports: number;
  requiredLamports: number;
}

const POLL_ACCOUNT_TYPE = "smart_account";

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
    return this.config.get<string>("PID_SOLANA_RPC_URL", "https://api.devnet.solana.com");
  }

  private marginRate(): number {
    const n = Number(this.config.get<string>("PID_ACTIVATION_MARGIN_RATE", "0.5"));
    return Number.isFinite(n) && n >= 0 ? n : 0.5;
  }

  /** Lazy pid-solana module (keeps @solana/web3.js out of Jest's transform graph). */
  private get pidSolana() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@peridotvault/pid-solana") as typeof import("@peridotvault/pid-solana");
  }

  private relayer(): Keypair {
    const { Keypair, fromHex } = this.pidSolana;
    const secret = this.config.getOrThrow<string>("PID_RELAYER_SECRET");
    return Keypair.fromSecretKey(fromHex(secret));
  }

  private treasury(): PublicKey {
    const { PublicKey } = this.pidSolana;
    const override = this.config.get<string>("PID_TREASURY_PUBKEY");
    return override ? new PublicKey(override) : this.relayer().publicKey;
  }

  private adapter(): SolanaAdapter {
    const { SolanaAdapter, SolanaRpc } = this.pidSolana;
    return new SolanaAdapter(new SolanaRpc(this.rpcUrl()));
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
        accountType: POLL_ACCOUNT_TYPE,
        status: { in: ["inactivated", "funded", "insufficient", "ready", "activating", "active"] },
      },
      include: { account: { select: { identityId: true } } },
    });
    if (pending.length === 0) return;

    const adapter = this.adapter();
    const cost = await adapter.estimateActivationCost(this.marginRate());

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
          await this.security.log(ca.account.identityId, "account.activation.promoted", { from: ca.status, to: "active" }, ca.accountId);
          continue;
        }
        if (ca.status === "active") {
          // stale active row on-chain not actually activated (e.g. earlier dropped tx)
          if (activated) continue;
          await this.prisma.chainAccount.update({
            where: { id: ca.id },
            data: { status: "inactivated", activationBalance: null, activationRequired: null },
          });
          await this.security.log(ca.account.identityId, "account.activation.healed", { from: "active", to: "inactivated" }, ca.accountId);
          continue;
        }

        const balance = await adapter.getBalanceOf(ca.address);
        const required = Number(cost.totalLamports);
        const next = this.classify(balance, required, ca.status);
        await this.prisma.chainAccount.update({
          where: { id: ca.id },
          data: { status: next, activationBalance: BigInt(balance), activationRequired: BigInt(required) },
        });
        await this.security.log(ca.account.identityId, "account.activation.polled", { status: next, balance }, ca.accountId);
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
    if (balance === 0) return "inactivated";
    if (balance < required) return "insufficient";
    if (current === "activating") return "activating";
    return "ready";
  }

  /** Activate a READY account (idempotent once ACTIVE). */
  async activate(user: { identityId: string }, accountId: string): Promise<ActivationView> {
    const chain = await this.prisma.chainAccount.findFirst({
      where: { chainNamespace: "solana", accountType: POLL_ACCOUNT_TYPE, accountId },
      include: { account: true },
    });
    if (!chain || chain.account.identityId !== user.identityId) {
      throw new NotFoundException("Account not found");
    }

    if (chain.status === "active") return this.viewOf(user, accountId);

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
    const cost = await adapter.estimateActivationCost(this.marginRate());
    const required = Number(cost.totalLamports);
    const live = activated ? "active" : this.classify(balance, required, chain.status);

    if (live === "active") return this.viewOf(user, accountId);

    if (live !== "ready") {
      throw new ConflictException(`Wallet must be READY to activate (currently ${live})`);
    }

    const authority = await this.prisma.authority.findFirst({
      where: { accountId, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    if (!authority) throw new ConflictException("No passkey registered — register one first");

    await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "activating" } });
    try {
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
        await this.security.log(user.identityId, "account.activation.relayer_unfunded", { relayer: this.relayer().publicKey.toBase58() }, accountId);
        throw new ServiceUnavailableException(
          "Peridot's activation service is temporarily out of funds. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }

      const signature = await adapter.activate(
        chain.account.id,
        coseToCompressedSecp256r1(Buffer.from(authority.publicKey)) as unknown as Uint8Array<ArrayBufferLike>,
        cost.totalLamports,
        this.relayer(),
        this.treasury(),
      );

      const { outcome, reason } = await this.confirmActivation(signature, chain.address);
      if (outcome !== "confirmed") {
        // Revert — the transaction never landed (or errored); the user's deposit is untouched.
        await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
        await this.security.log(user.identityId, "account.activation.unconfirmed", { signature, outcome, reason }, accountId);
        throw new ServiceUnavailableException(
          outcome === "failed"
            ? `Activation was submitted but failed on-chain${reason ? ` (${shortReason(reason)})` : ""}. No SOL was deducted from your wallet — please try again.`
            : "Activation was submitted but not confirmed on-chain yet. No SOL was deducted from your wallet — please try again in a moment.",
        );
      }

      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "active" } });
      // Activity history: the activation is the account creation + the on-chain reimbursement
      // of the float (rent + fee + margin) from the smart account to the Peridot treasury.
      await this.prisma.transaction
        .create({
          data: {
            accountId: chain.accountId,
            chainAccountId: chain.id,
            type: "ACTIVATION",
            amount: BigInt(cost.totalLamports),
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
      await this.security.log(user.identityId, "account.activated", { signature }, accountId);
    } catch (err) {
      await this.prisma.chainAccount.update({ where: { id: chain.id }, data: { status: "ready" } }).catch(() => undefined);
      throw err;
    }

    return this.viewOf(user, accountId);
  }

  /** Activation view derived live from on-chain state (ownership-checked). */
  async viewOf(user: { identityId: string }, accountId: string): Promise<ActivationView> {
    const chain = await this.prisma.chainAccount.findFirst({
      where: { chainNamespace: "solana", accountType: POLL_ACCOUNT_TYPE, accountId },
      include: { account: true },
    });
    if (!chain || chain.account.identityId !== user.identityId) {
      throw new NotFoundException("Account not found");
    }
    const adapter = this.adapter();
    let balance = 0;
    let activated = false;
    try {
      balance = await adapter.getBalanceOf(chain.address);
      activated = await adapter.isActivated(chain.address);
    } catch (err) {
      this.logger.warn(`activation view failed for ${chain.address}: ${(err as Error).message}`);
    }
    const cost = await adapter.estimateActivationCost(this.marginRate());
    const required = Number(cost.totalLamports);

    // Authoritative: a program-owned PDA is ACTIVE regardless of stored status.
    const status: ChainAccountStatus = activated
      ? "active"
      : this.classify(balance, required, chain.status);

    return {
      accountId: chain.accountId,
      status,
      smartAccountAddress: chain.address,
      balanceLamports: balance,
      requiredLamports: required,
    };
  }
}

/** Compact on-chain error for the UI — the full payload stays in the security log. */
function shortReason(err: string): string {
  const cleaned = err.trim();
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}…`;
}

