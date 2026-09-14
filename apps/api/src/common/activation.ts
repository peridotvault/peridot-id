// Shared activation state-machine pieces (Solana + EVM flows).
// Chain math (lamports vs wei) and liveness truth stay per-chain — only the
// identical branches live here.
import { ConflictException } from "@nestjs/common";
import type { ChainAccountStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

export function classifyActivation(balance: number, required: number, current: string): ChainAccountStatus;
export function classifyActivation(balance: bigint, required: bigint, current: string): ChainAccountStatus;
export function classifyActivation(balance: number | bigint, required: number | bigint, current: string): ChainAccountStatus {
  if (balance === 0 || balance === 0n) return "inactivated";
  // Callers always pass matching pairs (lamports/number or wei/bigint) —
  // the casts are compile-time only; runtime compares the original values.
  if ((balance as number) < (required as number)) return "insufficient";
  if (current === "activating") return "activating";
  return "ready";
}

/** Oldest active passkey — every signing flow requires one before proceeding. */
export async function requireActiveAuthority(prisma: PrismaService, pid: string) {
  const authority = await prisma.authority.findFirst({
    where: { pid, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!authority) throw new ConflictException("No passkey registered — register one first");
  return authority;
}
