// H3 circuit breaker (ANT-589): per-chain spend-rate guard on absorbed loss.
//
// Normative contract: deploy/relayer-breaker/README.md — caps from env in
// native base units (integer strings): BREAKER_CAP_SOLANA / _STELLAR /
// _ETHEREUM / _BASE / _BSC. Rolling window 1h (R-NFR-5/9), summed from
// relayer.pnl.absorbed (+ legacy *.reconciled.relayerAbsorbed) — the same Q4
// the alert check evaluates, so the breaker and the page can never disagree
// about the sum. Absorbed-loss definition: absorbed = max(0, actual − attested)
// per sponsored tx. Compiled default: 0 = breaker disabled (no env = no
// behavior change; caps are operator-owned, Trevor + CTO = OQ-3).
//
// Transitions emit the canonical H3 rows with the exact contract keys:
//   relayer.breaker.opened { chain, absorbedSum, cap, window, reason }
//   relayer.breaker.closed { chain, absorbedSum, cap, window, reason, operator, evidence }
// (operator + evidence on close supply the runbook §4 resume bar.)
// Opens fail closed: sponsored broadcasts pause (re-quote still serves); resume
// is manual via closeBreaker (runbook §4 owns who may resume).
//
// Rebase note (ANT-598): supersedes the PR #107 draft breaker (PID_RELAYER_*
// env, absorbedWindow snapshot key, pid-first requireClosed). Canonical env is
// BREAKER_CAP_<CHAIN>, snapshot key is absorbedSum, matching the ops contract
// (deploy/relayer-breaker/README.md + 56c0adf). withBoundedRetries is ported
// from #107; its park emission uses the canonical relay.parked_unreadable
// row (the only monitored park event) — this path has no nonce by
// construction (generic RPC retries, not resolve-then-act), so `op` rides
// along for triage instead.

import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecurityEventService } from "../security/security-event.service";
import {
  BREAKER_WINDOW,
  FeeChain,
  RelayerH1Events,
  backoffWithJitter,
  fmtBaseUnits,
  normalizeFeeChain,
} from "./relayer-events";

/** R-NFR-9: rolling absorbed-loss accounting window per chain. */
export const BREAKER_WINDOW_MS = 60 * 60 * 1000;

export interface BreakerSnapshot {
  chain: string;
  open: boolean;
  absorbedSum: string;
  cap: string;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  /** chain -> absorbed-loss events (timestamp ms, amount). Bounded by window sweep. */
  private readonly ledger = new Map<string, { at: number; amount: bigint }[]>();
  private readonly openChains = new Map<string, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
  ) {}

  /** Configured cap for a chain (bigint base units). Zero/negative/missing = breaker disabled. */
  capFor(chain: string): bigint {
    const raw = this.config.get<string>(`BREAKER_CAP_${chain.toUpperCase()}`, "0");
    try {
      const cap = BigInt(raw ?? "0");
      return cap > 0n ? cap : 0n;
    } catch {
      return 0n;
    }
  }

  /** Absorbed P&L recorded post-reconcile; opens the breaker on cap breach. */
  async recordAbsorbed(pid: string, chain: string, absorbed: bigint): Promise<BreakerSnapshot> {
    const feeChain = normalizeFeeChain(chain);
    const now = Date.now();
    const events = (this.ledger.get(feeChain) ?? []).filter((e) => now - e.at < BREAKER_WINDOW_MS);
    if (absorbed > 0n) events.push({ at: now, amount: absorbed });
    this.ledger.set(feeChain, events);
    const windowSum = events.reduce((acc, e) => acc + e.amount, 0n);
    const cap = this.capFor(feeChain);
    if (cap > 0n && windowSum >= cap && !this.openChains.has(feeChain)) {
      return this.open(pid, feeChain, windowSum, cap, "cap-breached");
    }
    return { chain: feeChain, open: this.openChains.has(feeChain), absorbedSum: fmtBaseUnits(windowSum), cap: fmtBaseUnits(cap) };
  }

  /** Fail-closed guard: sponsored broadcasts refuse while the breaker is open. */
  async requireClosed(chain: string, entryPoint: string): Promise<void> {
    const feeChain: FeeChain | "unknown" = normalizeFeeChain(chain);
    if (!this.openChains.has(feeChain)) return;
    this.logger.warn(`breaker blocking ${entryPoint} on ${feeChain} (open)`);
    throw new ServiceUnavailableException(
      "Sponsored transactions are paused while the relayer is reviewed — please re-quote and try again in a moment",
    );
  }

  isOpen(chain: string): boolean {
    return this.openChains.has(normalizeFeeChain(chain));
  }

  /** Manual open (runbook freeze path from §2/§3): on-call halt with a reason. Idempotent. */
  async openBreaker(pid: string, chain: string, reason: string): Promise<BreakerSnapshot> {
    const feeChain = this.requireFeeChain(chain);
    if (this.openChains.has(feeChain)) return this.snapshot(feeChain);
    return this.open(pid, feeChain, this.windowSum(feeChain), this.capFor(feeChain), reason);
  }

  /** Manual resume (runbook §4): operator-only caller, records the evidence. */
  async closeBreaker(operatorPid: string, chain: string, evidence: string, reason = "manual-resume"): Promise<BreakerSnapshot> {
    const feeChain = this.requireFeeChain(chain);
    if (!evidence || evidence.length > 2000) {
      throw new Error("closeBreaker requires evidence (1..2000 chars)");
    }
    const absorbedSum = this.windowSum(feeChain);
    const cap = this.capFor(feeChain);
    this.openChains.delete(feeChain);
    this.ledger.set(feeChain, []);
    await this.security.log(operatorPid, RelayerH1Events.breakerClosed, {
      chain: feeChain,
      absorbedSum: fmtBaseUnits(absorbedSum),
      cap: fmtBaseUnits(cap),
      window: BREAKER_WINDOW,
      reason,
      operator: operatorPid,
      evidence,
    });
    this.logger.log(`relayer breaker CLOSED for ${feeChain} by ${operatorPid}: ${reason}`);
    return { chain: feeChain, open: false, absorbedSum: fmtBaseUnits(0n), cap: fmtBaseUnits(cap) };
  }

  snapshot(chain: string): BreakerSnapshot {
    const feeChain = normalizeFeeChain(chain);
    const cap = this.capFor(feeChain);
    return {
      chain: feeChain,
      open: this.openChains.has(feeChain),
      absorbedSum: fmtBaseUnits(this.windowSum(feeChain)),
      cap: fmtBaseUnits(cap),
    };
  }

  private async open(pid: string, chain: string, windowSum: bigint, cap: bigint, reason: string): Promise<BreakerSnapshot> {
    this.openChains.set(chain, reason);
    await this.security.log(pid, RelayerH1Events.breakerOpened, {
      chain,
      absorbedSum: fmtBaseUnits(windowSum),
      cap: fmtBaseUnits(cap),
      window: BREAKER_WINDOW,
      reason,
    });
    this.logger.error(`relayer breaker OPENED for ${chain}: absorbedSum=${windowSum} cap=${cap} reason=${reason}`);
    return { chain, open: true, absorbedSum: fmtBaseUnits(windowSum), cap: fmtBaseUnits(cap) };
  }


  /**
   * R-NFR-7: bounded RPC retries with exponential backoff + jitter, then park
   * for operator review (never silent-drop, never storm). `nowMs` injectable
   * for tests.
   */
  async withBoundedRetries<T>(
    pid: string,
    chain: string,
    entryPoint: string,
    op: string,
    fn: () => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, backoffWithJitter(attempt)));
        }
      }
    }
    await this.security.log(pid, RelayerH1Events.parkedUnreadable, {
      entryPoint,
      chain,
      op,
      reason: "retry-bound-exhausted",
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    this.logger.error(`relayer parked after ${attempts} attempts: ${op} pid=${pid} chain=${chain}`);
    throw new ServiceUnavailableException(
      "The request was parked for operator review after repeated network errors — please try again in a moment",
    );
  }

  private windowSum(chain: string): bigint {
    const now = Date.now();
    const events = (this.ledger.get(chain) ?? []).filter((e) => now - e.at < BREAKER_WINDOW_MS);
    this.ledger.set(chain, events);
    return events.reduce((acc, e) => acc + e.amount, 0n);
  }

  private requireFeeChain(chain: string): string {
    const feeChain = normalizeFeeChain(chain);
    if (feeChain === "unknown") throw new Error(`unknown fee chain: ${chain}`);
    return feeChain;
  }
}
