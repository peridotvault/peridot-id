import { Injectable, NotFoundException } from "@nestjs/common";
import { ChainAccountStatus } from "@prisma/client";
import { ACCOUNT_TYPE_LINKED } from "../common/chains";
import { isP2002 } from "../prisma/prisma-error";
import { PrismaService } from "../prisma/prisma.service";
import { ChainRegistryService } from "../chain/chain-registry.service";
import { toChainView } from "../account/account.service";

export interface WalletView {
  id: string;
  chain: string;
  address: string;
  status: ChainAccountStatus;
  createdAt: Date;
}

function toView(ca: Parameters<typeof toChainView>[0]): WalletView {
  const v = toChainView(ca);
  return { id: v.id, chain: v.chainNamespace, address: v.address, status: v.status, createdAt: v.createdAt };
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: ChainRegistryService,
  ) {}

  async getMe(pid: string): Promise<WalletView> {
    const linked = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_LINKED },
      include: { chain: true },
    });
    if (!linked) throw new NotFoundException("Wallet not found");
    return toView(linked);
  }

  async create(pid: string, address: string): Promise<WalletView> {
    const existing = await this.prisma.chainAccount.findFirst({
      where: { pid, accountType: ACCOUNT_TYPE_LINKED },
      include: { chain: true },
    });
    if (existing) return toView(existing);

    const chainId = await this.chains.solanaChainIdOrThrow();

    try {
      const created = await this.prisma.chainAccount.create({
        data: {
          pid,
          chainId,
          address,
          accountType: ACCOUNT_TYPE_LINKED,
        },
        include: { chain: true },
      });
      return toView(created);
    } catch (err) {
      // ADR 004: one linked_address per identity. A concurrent duplicate hits the
      // unique index — return the existing row instead of failing (P2002, as before).
      if (isP2002(err)) {
        const existing2 = await this.prisma.chainAccount.findFirst({
          where: { pid, accountType: ACCOUNT_TYPE_LINKED },
          include: { chain: true },
        });
        if (existing2) return toView(existing2);
      }
      throw err;
    }
  }
}
