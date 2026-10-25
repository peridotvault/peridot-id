import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CHAIN_LOCK, GENESIS_HASH, entryHash, verifyChain as verifyLedgerChain } from "./fiat-ledger-hash";
import { PrismaService } from "../prisma/prisma.service";

/** Chain integrity: verify, head, and repair (fills NULL hashes only). */
@Injectable()
export class FiatLedgerChainService {
  constructor(private readonly prisma: PrismaService) {}

  /** Verify the whole chain; expose the head hash for external anchoring. */
  async verifyLedger(): Promise<{ ok: boolean; checked: number; headHash: string; firstBadIdempotencyKey: string | null; error: string | null; postedUnchained: number }> {
    const unchained = await this.prisma.fiatLedgerEntry.count({ where: { status: "posted", hash: null } });
    const rows = await this.prisma.fiatLedgerEntry.findMany({
      where: { status: "posted", hash: { not: null } }, orderBy: { hashSeq: "asc" }, take: 100000,
    });
    const v = verifyLedgerChain(rows.map((r) => ({
      entryGroup: r.entryGroup, kind: r.kind, pid: r.pid, counterpartyPid: r.counterpartyPid,
      amountIdr: r.amountIdr, direction: r.direction, idempotencyKey: r.idempotencyKey,
      parentRef: r.parentRef, status: r.status, feePolicyVersion: r.feePolicyVersion,
      prevHash: r.prevHash, hash: r.hash,
    })));
    if (unchained > 0) {
      const e = v.error ? `${v.error}; ${unchained} posted row(s) unchained` : `${unchained} posted row(s) unchained — run chain backfill`;
      return { ...v, ok: false, error: e, postedUnchained: unchained };
    }
    return { ...v, postedUnchained: 0 };
  }
  /** Head of the chain (the value to publish externally to make it tamper-proof). */
  async chainHead(): Promise<{ headHash: string; hashSeq: string | null }> {
    const last = await this.prisma.fiatLedgerEntry.findFirst({
      where: { hash: { not: null } }, orderBy: { hashSeq: "desc" }, select: { hash: true, hashSeq: true },
    });
    return { headHash: last?.hash ?? GENESIS_HASH, hashSeq: last?.hashSeq?.toString() ?? null };
  }
  /**
   * One-time/repair: chain posted rows that predate the chain (replaySeq order).
   * ANT-254 P2 note: yes, this UPDATEs posted rows — deliberately and narrowly.
   * It only fills NULL hash fields (posted-but-unchained rows) and never
   * rewrites an existing hash/prevHash/hashSeq, so chained history is
   * append-only in effect. Admin-guarded + throttled at the controller;
   * verifyLedger reports `postedUnchained` so the need is visible before use.
   */
  async backfillChain(): Promise<{ chained: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK}::bigint)`);
      const unchained = await tx.fiatLedgerEntry.findMany({
        where: { status: "posted", hash: null }, orderBy: { replaySeq: "asc" }, take: 100000,
      });
      const last = await tx.fiatLedgerEntry.findFirst({
        where: { hash: { not: null } }, orderBy: { hashSeq: "desc" }, select: { hash: true, hashSeq: true },
      });
      let prevHash: string = last?.hash ?? GENESIS_HASH;
      let seq: bigint = last?.hashSeq ?? 0n;
      for (const r of unchained) {
        seq += 1n;
        const hash = entryHash({
          entryGroup: r.entryGroup, kind: r.kind, pid: r.pid, counterpartyPid: r.counterpartyPid,
          amountIdr: r.amountIdr, direction: r.direction, idempotencyKey: r.idempotencyKey,
          parentRef: r.parentRef, status: r.status, feePolicyVersion: r.feePolicyVersion, prevHash,
        });
        await tx.fiatLedgerEntry.update({ where: { id: r.id }, data: { prevHash, hash, hashSeq: seq } });
        prevHash = hash;
      }
      return { chained: unchained.length };
    });
  }
}
