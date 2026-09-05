import { Injectable, NotFoundException } from "@nestjs/common";
import { ChainAccountStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface WalletView {
  id: string;
  chain: string;
  address: string;
  status: ChainAccountStatus;
  createdAt: Date;
}

// ADR 004: the V3 wallet surface is preserved as a read of the default account's
// `linked_address` chain account. Deprecated — never returns `smart_account` rows.
const CHAIN_NAMESPACE = "solana";
const SOLANA_MAINNET_REFERENCE = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
const ACCOUNT_TYPE_LINKED = "linked_address";

function toView(ca: {
  id: string;
  chainNamespace: string;
  address: string;
  status: ChainAccountStatus;
  createdAt: Date;
}): WalletView {
  return { id: ca.id, chain: ca.chainNamespace, address: ca.address, status: ca.status, createdAt: ca.createdAt };
}

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(identityId: string): Promise<WalletView> {
    const account = await this.prisma.pidAccount.findFirst({
      where: { identityId, status: "active" },
      include: { chainAccounts: { where: { accountType: ACCOUNT_TYPE_LINKED }, take: 1 } },
    });
    const linked = account?.chainAccounts[0];
    if (!linked) throw new NotFoundException("Wallet not found");
    return toView(linked);
  }

  async create(identityId: string, address: string): Promise<WalletView> {
    let account = await this.prisma.pidAccount.findFirst({ where: { identityId, status: "active" } });
    if (!account) {
      account = await this.prisma.pidAccount.create({ data: { identityId } });
    }

    const existing = await this.prisma.chainAccount.findFirst({
      where: { accountId: account.id, accountType: ACCOUNT_TYPE_LINKED },
    });
    if (existing) return toView(existing);

    try {
      const created = await this.prisma.chainAccount.create({
        data: {
          accountId: account.id,
          chainNamespace: CHAIN_NAMESPACE,
          chainReference: SOLANA_MAINNET_REFERENCE,
          address,
          accountType: ACCOUNT_TYPE_LINKED,
        },
      });
      return toView(created);
    } catch (err) {
      // ADR 004: one linked_address per default account. A concurrent duplicate hits the
      // unique index — return the existing row instead of failing (P2002, as before).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing2 = await this.prisma.chainAccount.findFirst({
          where: { accountId: account.id, accountType: ACCOUNT_TYPE_LINKED },
        });
        if (existing2) return toView(existing2);
      }
      throw err;
    }
  }
}