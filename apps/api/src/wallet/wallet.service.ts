import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Wallet } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type WalletView = Pick<Wallet, "id" | "chain" | "address" | "status" | "createdAt">;

// ADR 003: single-chain Solana MVP. Multi-chain is out of V3.
const WALLET_CHAIN = "solana";

// Explicit select — no sensitive material can appear in a response (PRD §9).
const WALLET_SELECT = { id: true, chain: true, address: true, status: true, createdAt: true } as const;

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(identityId: string): Promise<WalletView> {
    const wallet = await this.prisma.wallet.findUnique({ where: { identityId }, select: WALLET_SELECT });
    if (!wallet) throw new NotFoundException("Wallet tidak ditemukan");
    return wallet;
  }

  async create(identityId: string, address: string): Promise<WalletView> {
    const existing = await this.prisma.wallet.findUnique({ where: { identityId }, select: WALLET_SELECT });
    if (existing) return existing;

    try {
      return await this.prisma.wallet.create({
        data: { identityId, chain: WALLET_CHAIN, address },
        select: WALLET_SELECT,
      });
    } catch (err) {
      // ADR 003: one wallet per PID. A concurrent duplicate hits the unique index — return
      // the existing wallet instead of failing (same P2002 pattern as profile.service).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const wallet = await this.prisma.wallet.findUnique({ where: { identityId }, select: WALLET_SELECT });
        if (wallet) return wallet;
      }
      throw err;
    }
  }
}
