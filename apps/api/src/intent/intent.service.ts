import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Intent, IntentStatus, Transaction, TransactionStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";

const INTENT_TTL_MS = 5 * 60 * 1000; // PRD_v4 §22: intent expiration
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type IntentType = "WITHDRAW_SOL" | "WITHDRAW_TOKEN";

export interface IntentInput {
  type: IntentType;
  payload: {
    amount: string;
    destination?: string; // WITHDRAW_SOL
    mint?: string; // WITHDRAW_TOKEN
    destinationAta?: string; // WITHDRAW_TOKEN
  };
}

export interface IntentView {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface TransactionView {
  id: string;
  intentId: string | null;
  type: string | null;
  amount: string | null;
  asset: string | null;
  direction: string | null;
  counterparty: string | null;
  chain: string;
  network: string;
  txHash: string | null;
  status: string;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface ActivityInput {
  type: "DEPOSIT" | "WITHDRAW" | "ACTIVATION";
  amount: string; // lamports / raw token units as decimal string
  asset: string;
  direction: "in" | "out";
  counterparty?: string;
  txHash?: string;
}

function toIntentView(i: Intent): IntentView {
  return { id: i.id, type: i.type, payload: i.payload as Record<string, unknown>, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt };
}

function toTxView(t: Transaction): TransactionView {
  return {
    id: t.id,
    intentId: t.intentId,
    type: t.type,
    amount: t.amount == null ? null : t.amount.toString(),
    asset: t.asset,
    direction: t.direction,
    counterparty: t.counterparty,
    chain: t.chain,
    network: t.network,
    txHash: t.txHash,
    status: t.status,
    createdAt: t.createdAt,
    confirmedAt: t.confirmedAt,
  };
}

@Injectable()
export class IntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  private network(): string {
    return this.config.get<string>("SOLANA_NETWORK") ?? "devnet";
  }

  /** The identity's default account with its smart-account chain row (ownership from token). */
  private async resolveAccount(identityId: string) {
    const account = await this.prisma.pidAccount.findFirst({
      where: { identityId, status: "active" },
      include: { chainAccounts: { where: { status: "active" } } },
    });
    if (!account) throw new NotFoundException("Account not found");
    const smart = account.chainAccounts.find((c) => c.accountType === "smart_account");
    if (!smart) throw new BadRequestException("Smart account not created");
    return { account, smart };
  }

  private async assertAuthority(accountId: string): Promise<void> {
    const count = await this.prisma.authority.count({ where: { accountId, status: "active" } });
    if (count === 0) throw new BadRequestException("No registered credentials");
  }

  private assertPubkey(value: string | undefined, field: string): void {
    if (!value || !SOLANA_PUBKEY_RE.test(value)) {
      throw new BadRequestException(`${field} is invalid`);
    }
  }

  private assertAmount(amount: string | undefined): void {
    if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new BadRequestException("Jumlah harus lebih dari 0");
    }
  }

  async createIntent(identityId: string, input: IntentInput): Promise<IntentView> {
    const { account, smart } = await this.resolveAccount(identityId);
    await this.assertAuthority(account.id);

    // §5.5 policy: shape + ownership + destination/amount validation.
    this.assertAmount(input.payload.amount);
    if (input.type === "WITHDRAW_SOL") {
      this.assertPubkey(input.payload.destination, "Tujuan");
      if (input.payload.destination === smart.address) {
        throw new BadRequestException("Destination cannot be the smart account itself");
      }
    } else if (input.type === "WITHDRAW_TOKEN") {
      this.assertPubkey(input.payload.mint, "Mint");
      this.assertPubkey(input.payload.destinationAta, "Tujuan");
    } else {
      throw new BadRequestException("Unsupported intent type");
    }

    const intent = await this.prisma.intent.create({
      data: {
        accountId: account.id,
        type: input.type,
        payload: {
          ...input.payload,
          chain: "solana",
          network: this.network(),
          accountId: account.id,
          smartAccountAddress: smart.address,
        },
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      },
    });

    await this.security.log(identityId, "intent.created", { intentId: intent.id, type: intent.type }, account.id);
    return toIntentView(intent);
  }

  async getIntent(identityId: string, intentId: string): Promise<IntentView> {
    const intent = await this.prisma.intent.findFirst({
      where: { id: intentId, account: { identityId } },
    });
    if (!intent) throw new NotFoundException("Intent not found");
    return toIntentView(intent);
  }

  /**
   * Record an executed transaction against a pending, unexpired intent (single-use replay
   * protection + audit trail, PRD_v4 §22). The on-chain submission itself runs through the
   * SDK/adapter; this records the outcome.
   */
  async recordTransaction(
    identityId: string,
    input: { intentId: string; txHash: string; network?: string },
  ): Promise<TransactionView> {
    const { account, smart } = await this.resolveAccount(identityId);
    const intent = await this.prisma.intent.findFirst({
      where: { id: input.intentId, accountId: account.id },
    });
    if (!intent) throw new NotFoundException("Intent not found");

    if (intent.status !== "pending") {
      await this.security.log(identityId, "intent.replay_rejected", { intentId: intent.id }, account.id);
      throw new BadRequestException("Intent sudah dipakai");
    }
    if (intent.expiresAt < new Date()) {
      await this.security.log(identityId, "intent.expired", { intentId: intent.id }, account.id);
      throw new BadRequestException("Intent sudah kedaluwarsa");
    }

    const tx = await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        chainAccountId: smart.id,
        intentId: intent.id,
        chain: "solana",
        network: input.network ?? this.network(),
        txHash: input.txHash,
        status: "submitted" as TransactionStatus,
      },
    });
    await this.prisma.intent.update({ where: { id: intent.id }, data: { status: "executed" as IntentStatus } });

    await this.security.log(identityId, "intent.executed", { intentId: intent.id, txHash: input.txHash }, account.id);
    return toTxView(tx);
  }

  async getTransaction(identityId: string, txId: string): Promise<TransactionView> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: txId, account: { identityId } },
    });
    if (!tx) throw new NotFoundException("Transaction not found");
    return toTxView(tx);
  }

  /** Newest-first activity history for the identity's default account. */
  async listTransactions(identityId: string, take = 50): Promise<TransactionView[]> {
    const txs = await this.prisma.transaction.findMany({
      where: { account: { identityId } },
      orderBy: { createdAt: "desc" },
      take,
    });
    return txs.map(toTxView);
  }

  /**
   * Record a completed on-chain operation (deposit/withdrawal/activation) directly as a
   * Transaction row — the activity-history record. No intent lifecycle involved.
   */
  async recordActivity(identityId: string, input: ActivityInput): Promise<TransactionView> {
    const { account, smart } = await this.resolveAccount(identityId);
    const tx = await this.prisma.transaction.create({
      data: {
        accountId: account.id,
        chainAccountId: smart.id,
        type: input.type,
        amount: BigInt(input.amount),
        asset: input.asset,
        direction: input.direction,
        counterparty: input.counterparty ?? null,
        chain: "solana",
        network: this.network(),
        txHash: input.txHash ?? null,
        status: "submitted" as TransactionStatus,
      },
    });
    await this.security.log(identityId, "activity.recorded", { txId: tx.id, type: input.type }, account.id);
    return toTxView(tx);
  }

  /** Expired intents are marked expired (never executed) — run by a sweep or on access. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.intent.updateMany({
      where: { status: "pending", expiresAt: { lt: new Date() } },
      data: { status: "expired" as IntentStatus },
    });
    return result.count;
  }
}