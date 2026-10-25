// H2 idempotency (ANT-575 FR-H.2, R-NFR-8, R-NFR-11) — at-most-once broadcast
// ledger per (pid, nonce, chain) + resolve-then-act on ambiguous RPC outcome.
//
// Rules enforced here:
//  - Same-signed-intent retries never re-sign: identical bytes reuse the slot.
//  - ONE identical-bytes rebroadcast ONLY on provable pre-confirmation failure.
//  - Post-confirmation failures alert, never rebroadcast.
//  - DIFFERENT bytes under SAME nonce are FORBIDDEN in all cases.
//  - Ambiguous RPC outcome → resolve chain state first (bounded: ≤5 reads,
//    backoff+jitter, ≤30s total); rebroadcast identical bytes ONLY on proven
//    non-landing; park + alert when unreadable.
// Outcome labels: resolved-landed | resolved-not-landed-rebroadcast | parked-unreadable.

import { ConflictException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isP2002 } from "../prisma/prisma-error";
import { SecurityEventService } from "../security/security-event.service";
import { RelayerEvents, ResolveOutcome, SponsoredEntryPoint, backoffWithJitter } from "./relayer-events";

export const BROADCAST_CHAIN_SOLANA = "solana";
export const BROADCAST_CHAIN_EIP155 = "eip155";

export type BroadcastStatus =
  | "claimed"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired"
  | "rebroadcast"
  | "resolved-landed"
  | "resolved-not-landed-rebroadcast"
  | "parked-unreadable";

export interface ClaimResult {
  /** "proceed" = first claim, caller must broadcast. "duplicate" = identical bytes already broadcast. */
  decision: "proceed" | "duplicate";
  signature: string | null;
}

export type ChainStateResolution =
  | { landed: true; signature: string | null }
  | { landed: false }
  | { unreadable: true };

/** Deterministic broadcast failures (revert/simulation/validation): resolve would be pointless. */
export function isDeterministicBroadcastError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /revert|simulation failed|invalid|bad signature|blockhash not found|already been processed|duplicate/i.test(
    msg,
  );
}

/** R-NFR-11: chain-state resolve bound: at most 5 resolve attempts. Each attempt may do up to ~2 RPC reads (e.g. nonce + history), so ~10 reads worst-case. No per-attempt timeout yet, so the 30s budget is advisory and a hung RPC can blow it; attempts are still bounded. */
export const RESOLVE_MAX_ATTEMPTS = 5;
export const RESOLVE_BUDGET_MS = 30_000;

/** F1: a rotation slot older than this can never confirm a live ceremony (authorizations expire <=600s). */
export const ROTATION_SLOT_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class RelayerIdempotencyService {
  private readonly logger = new Logger(RelayerIdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  /**
   * Claim the (pid, nonce, chain) slot before broadcast. EVM entry points use
   * the authorization deadline in `nonce` (EVM has no nonce; column holds the
   * replay-protection scalar either way).
   *
   * `txBytesHash` is the sha256 of the canonical signed intent (params +
   * assertion signature), NOT the wire bytes: blockhash/fee metadata may vary
   * per attempt while the signed authorization is identical. Replay safety
   * rests on the on-chain nonce — identical intents can never execute twice.
   */
  async claimSlot(
    pid: string,
    nonce: string,
    chain: string,
    txBytesHash: string,
    entryPoint: SponsoredEntryPoint,
  ): Promise<ClaimResult> {
    const existing = await this.prisma.relayerBroadcast.findUnique({
      where: { pid_nonce_chain_entryPoint: { pid, nonce, chain, entryPoint } },
    });
    if (!existing) {
      try {
        await this.prisma.relayerBroadcast.create({
          data: { pid, nonce, chain, entryPoint, txBytesHash, status: "claimed" },
        });
      } catch (err) {
        // Concurrent identical claims both passed the check: the unique index
        // arbitrates. Re-read the winner and proceed as duplicate/forbidden
        // instead of surfacing a 500.
        if (!isP2002(err)) throw err;
        return this.claimSlot(pid, nonce, chain, txBytesHash, entryPoint);
      }
      return { decision: "proceed", signature: null };
    }
    if (existing.txBytesHash === txBytesHash) {
      // Same signed intent retried while nonce unconsumed + unexpired: no new
      // broadcast. The earlier submission (if any) IS the execution.
      if (existing.signature) {
        await this.security.log(pid, RelayerEvents.duplicateSuppressed, {
          entryPoint,
          chain,
          nonce,
          signature: existing.signature,
        });
      }
      return { decision: "duplicate", signature: existing.signature };
    }
    // DIFFERENT bytes under the SAME nonce: FORBIDDEN in all cases — never a
    // conflicting submission; a superseding intent needs a fresh nonce.
    await this.security.log(pid, RelayerEvents.conflictingBytesRejected, {
      entryPoint,
      chain,
      nonce,
      status: existing.status,
    });
    throw new ConflictException(
      "A different transaction under the same authorization is forbidden — re-quote for a fresh nonce",
    );
  }

  async recordSubmission(
    pid: string,
    nonce: string,
    chain: string,
    entryPoint: SponsoredEntryPoint,
    signature: string,
  ): Promise<void> {
    await this.prisma.relayerBroadcast.update({
      where: { pid_nonce_chain_entryPoint: { pid, nonce, chain, entryPoint } },
      data: { signature, status: "submitted" },
    });
  }

  async recordOutcome(
    pid: string,
    nonce: string,
    chain: string,
    entryPoint: SponsoredEntryPoint,
    status: BroadcastStatus,
    signature?: string,
  ): Promise<void> {
    await this.prisma.relayerBroadcast.update({
      where: { pid_nonce_chain_entryPoint: { pid, nonce, chain, entryPoint } },
      data: { status, ...(signature ? { signature } : {}) },
    });
  }

  /**
   * Rotation double-guard (H2.iv): a second rotation MUST NOT be submitted
   * while a previous one may still confirm. Self-healing (F1): a slot whose
   * nonce no longer matches the chain can never land (stale authorization),
   * and a slot older than the rotation TTL can never confirm a live ceremony
   * -- both are released as `expired` instead of bricking rotation forever.
   * Only a fresh slot on the CURRENT nonce blocks. Resolved by polling
   * ceremony state, not by a new nonce.
   */
  async assertNoInflightRotation(pid: string, chain: string, currentNonce: bigint): Promise<void> {
    const inflight = await this.prisma.relayerBroadcast.findFirst({
      where: { pid, chain, entryPoint: "rotate", status: { in: ["claimed", "submitted", "rebroadcast"] } },
    });
    if (!inflight) return;
    const ageMs = Date.now() - new Date(inflight.updatedAt).getTime();
    if (BigInt(inflight.nonce) !== currentNonce || ageMs > ROTATION_SLOT_TTL_MS) {
      await this.recordOutcome(pid, inflight.nonce, chain, "rotate", "expired");
      await this.security.log(pid, RelayerEvents.rotationUnconfirmed, {
        chain,
        nonce: inflight.nonce,
        signature: inflight.signature,
        guard: "stale-slot-released",
      });
      return;
    }
    await this.security.log(pid, RelayerEvents.rotationUnconfirmed, {
      chain,
      nonce: inflight.nonce,
      signature: inflight.signature,
      guard: "double-rotation",
    });
    throw new ServiceUnavailableException(
      "A rotation may still be confirming — check ceremony state before retrying (double-rotation guard)",
    );
  }

  /**
   * Broadcast with resolve-then-act. `broadcast` performs the single allowed
   * submission; `resolveState` reads chain state (account nonce + tx status).
   * Returns the canonical signature and outcome; throws 503-parked when the
   * chain state is unreadable after the bound, and rethrows deterministic
   * failures untouched.
   */
  async broadcastWithResolveThenAct<TBroadcast>(
    opts: {
      pid: string;
      nonce: string;
      chain: string;
      entryPoint: SponsoredEntryPoint;
      broadcast: () => Promise<{ signature: string; result: TBroadcast }>;
      resolveState: () => Promise<ChainStateResolution>;
    },
  ): Promise<{ signature: string | null; result: TBroadcast | null; outcome: ResolveOutcome | "broadcast-ok" }> {
    const { pid, nonce, chain, entryPoint } = opts;
    let signature: string;
    let result: TBroadcast;
    try {
      const out = await opts.broadcast();
      signature = out.signature;
      result = out.result;
    } catch (err) {
      if (isDeterministicBroadcastError(err)) throw err;
      return this.resolveThenAct(opts);
    }
    await this.recordSubmission(pid, nonce, chain, entryPoint, signature);
    return { signature, result, outcome: "broadcast-ok" };
  }

  private async resolveThenAct<TBroadcast>(opts: {
    pid: string;
    nonce: string;
    chain: string;
    entryPoint: SponsoredEntryPoint;
    broadcast: () => Promise<{ signature: string; result: TBroadcast }>;
    resolveState: () => Promise<ChainStateResolution>;
  }): Promise<{ signature: string | null; result: TBroadcast | null; outcome: ResolveOutcome }> {
    const { pid, nonce, chain, entryPoint } = opts;
    const resolution = await this.resolveWithBound(opts.resolveState);
    if ("unreadable" in resolution) {
      // Chain state UNREADABLE after the bound: park + alert, never blind-broadcast.
      await this.recordOutcome(pid, nonce, chain, entryPoint, "parked-unreadable");
      await this.security.log(pid, RelayerEvents.parkedUnreadable, { entryPoint, chain, nonce });
      await this.security.log(pid, RelayerEvents.parked, {
        entryPoint,
        chain,
        nonce,
        reason: "ambiguous-rpc-unreadable-after-bound",
      });
      this.logger.error(`relayer parked (unreadable chain state): pid=${pid} nonce=${nonce} chain=${chain}`);
      throw new ServiceUnavailableException(
        "The network outcome is unclear and the request was parked for operator review — no funds moved twice",
      );
    }
    if (resolution.landed) {
      // Chain state proves landing: treat as success (reconcile, no rebroadcast).
      // A null signature means proven-landed but unattributed (nonce consumed,
      // history unreadable) — reconcile what can be reconciled, alert the rest.
      await this.recordOutcome(pid, nonce, chain, entryPoint, "resolved-landed", resolution.signature ?? undefined);
      await this.security.log(pid, RelayerEvents.resolvedLanded, {
        entryPoint,
        chain,
        nonce,
        signature: resolution.signature,
      });
      return { signature: resolution.signature, result: null, outcome: "resolved-landed" };
    }
    // Proven non-landing: the ONE allowed identical-bytes rebroadcast.
    const out = await opts.broadcast();
    await this.recordOutcome(pid, nonce, chain, entryPoint, "resolved-not-landed-rebroadcast", out.signature);
    await this.security.log(pid, RelayerEvents.rebroadcast, {
      entryPoint,
      chain,
      nonce,
      signature: out.signature,
    });
    await this.security.log(pid, RelayerEvents.resolvedNotLandedRebroadcast, {
      entryPoint,
      chain,
      nonce,
      signature: out.signature,
    });
    return { signature: out.signature, result: out.result, outcome: "resolved-not-landed-rebroadcast" };
  }

  /** Up to 5 resolve attempts (~10 RPC reads worst-case), backoff+jitter between attempts, advisory 30s total budget. */
  private async resolveWithBound(
    resolveState: () => Promise<ChainStateResolution>,
  ): Promise<ChainStateResolution> {
    const started = Date.now();
    for (let attempt = 0; attempt < RESOLVE_MAX_ATTEMPTS; attempt++) {
      try {
        return await resolveState();
      } catch (err) {
        this.logger.warn(`resolve attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
      if (attempt < RESOLVE_MAX_ATTEMPTS - 1) {
        const delay = backoffWithJitter(attempt);
        if (Date.now() - started + delay > RESOLVE_BUDGET_MS) break;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return { unreadable: true };
  }
}
