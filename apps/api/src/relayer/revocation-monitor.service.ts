// H1.i revocation spike monitor (ANT-575 R-NFR-5): revocations/min vs
// trailing-1h baseline per chain. > 5x within the 10-min window fires
// `revocation.spike` (alert ≤ 5 min: the security.log write IS the alert
// emission Trevor's pipeline pages on). Chain-agnostic revokes (registry-only
// credential revoke) record under the "global" key; rotation revokes record
// under their chain.

import { Injectable, Logger } from "@nestjs/common";
import { SecurityEventService } from "../security/security-event.service";
import { RelayerEvents, isRevocationSpike } from "./relayer-events";

/** R-NFR-5: 10-min recent window vs trailing-1h baseline. */
export const SPIKE_RECENT_WINDOW_MS = 10 * 60 * 1000;
export const SPIKE_BASELINE_WINDOW_MS = 60 * 60 * 1000;

export interface RevocationSnapshot {
  chain: string;
  recentPerMin: number;
  baselinePerMin: number;
  spike: boolean;
}

@Injectable()
export class RevocationMonitor {
  private readonly logger = new Logger(RevocationMonitor.name);
  /** chain -> revocation timestamps (ms). Swept on every record. */
  private readonly events = new Map<string, number[]>();

  constructor(private readonly security: SecurityEventService) {}

  async recordRevocation(pid: string, chain: string, nowMs = Date.now()): Promise<RevocationSnapshot> {
    const kept = (this.events.get(chain) ?? []).filter((t) => nowMs - t < SPIKE_BASELINE_WINDOW_MS);
    kept.push(nowMs);
    this.events.set(chain, kept);
    const recent = kept.filter((t) => nowMs - t < SPIKE_RECENT_WINDOW_MS).length;
    const recentPerMin = recent / 10;
    const baselinePerMin = kept.length / 60;
    const spike = isRevocationSpike(recentPerMin, baselinePerMin, recent);
    if (spike) {
      await this.security.log(pid, RelayerEvents.revocationSpike, {
        chain,
        recentPerMin,
        baselinePerMin,
      });
      this.logger.error(`revocation spike on ${chain}: ${recentPerMin}/min vs baseline ${baselinePerMin}/min`);
    }
    return { chain, recentPerMin, baselinePerMin, spike };
  }
}
