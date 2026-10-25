// H3 operational safeguards (ANT-575 FR-H.3, R-NFR-7, R-NFR-9):
// per-chain spend-rate circuit breaker + bounded retries with park.
//
// Cap VALUES are Trevor+CTO owned (OQ-3) — this ships the mechanism with
// configurable caps, in native base units (lamports / stroops / wei,
// integer strings). Two env families are canonical (ANT-601 reconciliation;
// repo convention is `PID_*` per AGENTS.md, ops/alerts use `BREAKER_CAP_*`):
// per-chain `PID_RELAYER_BREAKER_CAP_LAMPORTS_<CHAIN>` (chain key uppercased,
// e.g. `_SOLANA`), then per-chain alias `BREAKER_CAP_<CHAIN>`, then global
// default `PID_RELAYER_BREAKER_CAP_LAMPORTS`. First set, non-empty value
// wins; unset/invalid everywhere means "0" = breaker disabled for that chain.
// The alert check (`deploy/alerts/relayer-h1-check.sh`) mirrors this exact
// precedence, so the breaker and the page can never disagree about the cap.
// Rolling window: 1h absorbed-loss sum per chain (R-NFR-9). Breaker opens → sponsored broadcasts pause
// fail-closed (re-quote still serves); resume is manual via `closeBreaker`
// (runbook §H4.4 owns who may resume).

import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { RelayerEvents, backoffWithJitter } from "./relayer-events";

/** R-NFR-9: rolling absorbed-loss accounting window per chain. */
export const BREAKER_WINDOW_MS = 60 * 60 * 1000;

export interface BreakerSnapshot {
  chain: string;
  open: boolean;
  absorbedWindow: string;
  cap: string;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  /** chain -> absorbed-loss events (timestamp ms, amount). Bounded by window sweep. */
  private readonly ledger = new Map<string, { at: number; amount: bigint }[]>();
  private readonly openChains = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  /**
   * Configured cap for a chain (bigint base units). Zero/negative = breaker
   * disabled. Resolution order (ANT-601): per-chain `PID_…_<CHAIN>`, then
   * per-chain `BREAKER_CAP_<CHAIN>` alias, then global `PID_…` default.
   * Empty strings count as unset so a stray empty export cannot shadow a
   * real value; unparsable values fail safe to 0 (disabled).
   */
  capFor(chain: string): bigint {
    const upper = chain.toUpperCase();
    const raw =
      this.firstSet(
        `PID_RELAYER_BREAKER_CAP_LAMPORTS_${upper}`,
        `BREAKER_CAP_${upper}`,
        "PID_RELAYER_BREAKER_CAP_LAMPORTS",
      ) ?? "0";
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }

  /** First configured, non-empty value across the given env keys, if any. */
  private firstSet(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.config.get<string>(key);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  /** Absorbed P&L recorded post-reconcile; opens the breaker on cap breach. */
  async recordAbsorbed(pid: string, chain: string, absorbed: bigint): Promise<BreakerSnapshot> {
    const now = Date.now();
    const events = (this.ledger.get(chain) ?? []).filter((e) => now - e.at < BREAKER_WINDOW_MS);
    if (absorbed > 0n) events.push({ at: now, amount: absorbed });
    this.ledger.set(chain, events);
    const windowSum = events.reduce((acc, e) => acc + e.amount, 0n);
    const cap = this.capFor(chain);
    if (cap > 0n && windowSum >= cap && !this.openChains.has(chain)) {
      this.openChains.add(chain);
      await this.security.log(pid, RelayerEvents.breakerOpened, {
        chain,
        absorbedWindow: windowSum.toString(),
        cap: cap.toString(),
      });
      this.logger.error(`relayer breaker OPENED for ${chain}: absorbed=${windowSum} cap=${cap}`);
    }
    return { chain, open: this.openChains.has(chain), absorbedWindow: windowSum.toString(), cap: cap.toString() };
  }

  /** Fail-closed guard: sponsored broadcasts refuse while the breaker is open. */
  async requireClosed(pid: string, chain: string, entryPoint: string): Promise<void> {
    if (!this.openChains.has(chain)) return;
    await this.security.log(pid, RelayerEvents.intentRejected, {
      entryPoint,
      chain,
      cause: "breaker-open",
    });
    throw new ServiceUnavailableException(
      "Sponsored transactions are paused while the relayer is reviewed — please re-quote and try again in a moment",
    );
  }

  isOpen(chain: string): boolean {
    return this.openChains.has(chain);
  }

  /** Manual resume (runbook §H4.4): operator-only caller, records the evidence. */
  async closeBreaker(pid: string, chain: string, evidence: string): Promise<BreakerSnapshot> {
    this.openChains.delete(chain);
    this.ledger.set(chain, []);
    const cap = this.capFor(chain);
    await this.security.log(pid, RelayerEvents.breakerClosed, { chain, evidence });
    return { chain, open: false, absorbedWindow: "0", cap: cap.toString() };
  }

  snapshot(chain: string): BreakerSnapshot {
    const now = Date.now();
    const events = (this.ledger.get(chain) ?? []).filter((e) => now - e.at < BREAKER_WINDOW_MS);
    const windowSum = events.reduce((acc, e) => acc + e.amount, 0n);
    return {
      chain,
      open: this.openChains.has(chain),
      absorbedWindow: windowSum.toString(),
      cap: this.capFor(chain).toString(),
    };
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
    await this.security.log(pid, RelayerEvents.parked, {
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
}
