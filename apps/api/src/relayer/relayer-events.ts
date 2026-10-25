// Relayer hardening (ANT-575 FR-H, board-accepted spec rev 3) — H1 observability
// vocabulary + H3 pure helpers. Field/event names are normative for Trevor's
// dashboards (ANT-582); any rename must be coordinated with DevOps first.
//
// Event-name catalog (all breaches ALSO write `security.log` events):
//   intent.rejected            pre-broadcast validation failure { entryPoint, chain, cause }
//   quote.drift_rejected       submit-time fee drifted beyond 120% { entryPoint, chain, quoted, attested }
//   relayer.reconciled         post-confirmation reconcile record (existing `{kind}.reconciled` kept)
//   relayer.formula_mismatch   protocolFee != formula(networkFee) { signature, entryPoint, chain, attested, actual, expected }
//   relayer.over_attested      attested fee exceeds actual beyond drift { signature, entryPoint, chain, attested, actual, expected }
//   relayer.pnl                per-tx relayer P&L { absorbed, signature, entryPoint, chain }
//   revocation.spike           revocations/min > 5x trailing-1h baseline { chain, recentPerMin, baselinePerMin }
//   rotation.confirmed_latency rotation confirm latency { chain, latencyMs, confirmed }
//   credential.rotation.unconfirmed (existing) 15x1s bound hit, 503 path
//   relayer.breaker.opened/closed  spend-rate circuit breaker transitions { chain, absorbedWindow, cap }
//   broadcast.duplicate_suppressed same-signed-intent retry, no new broadcast { signature }
//   broadcast.rebroadcast      ONE identical-bytes rebroadcast after provable pre-confirm failure
//   broadcast.conflicting_bytes_rejected DIFFERENT bytes under SAME nonce — FORBIDDEN { }
//   broadcast.resolved_landed | broadcast.resolved_not_landed_rebroadcast | broadcast.parked_unreadable
//   relayer.parked             intent parked for operator review { reason }

/** Sponsored entry points covered by H1 (per chain + per entry point). */
export const SPONSORED_ENTRY_POINTS = ["withdraw", "execute", "rotate", "activate"] as const;
export type SponsoredEntryPoint = (typeof SPONSORED_ENTRY_POINTS)[number];

/** Typed intent-rejection causes (H1.ii + H-AC6 taxonomy). */
export const INTENT_REJECTION_CAUSES = [
  "stale-nonce",
  "expired",
  "over-ttl",
  "drift",
  "policy-unknown",
  "insufficient-funds",
  "unauthorized",
  "conflicting-nonce-reuse",
  "breaker-open",
  "not-ready",
  "relayer-unfunded",
] as const;
export type IntentRejectionCause = (typeof INTENT_REJECTION_CAUSES)[number];

/** Resolve-then-act outcome labels (H2.v, dashboarded per pid/nonce/chain). */
export const RESOLVE_OUTCOMES = [
  "resolved-landed",
  "resolved-not-landed-rebroadcast",
  "parked-unreadable",
] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

export const RelayerEvents = {
  intentRejected: "intent.rejected",
  quoteDriftRejected: "quote.drift_rejected",
  formulaMismatch: "relayer.formula_mismatch",
  overAttested: "relayer.over_attested",
  pnl: "relayer.pnl",
  revocationSpike: "revocation.spike",
  rotationLatency: "rotation.confirmed_latency",
  rotationUnconfirmed: "credential.rotation.unconfirmed",
  breakerOpened: "relayer.breaker.opened",
  breakerClosed: "relayer.breaker.closed",
  duplicateSuppressed: "broadcast.duplicate_suppressed",
  rebroadcast: "broadcast.rebroadcast",
  conflictingBytesRejected: "broadcast.conflicting_bytes_rejected",
  resolvedLanded: "broadcast.resolved_landed",
  resolvedNotLandedRebroadcast: "broadcast.resolved_not_landed_rebroadcast",
  parkedUnreadable: "broadcast.parked_unreadable",
  parked: "relayer.parked",
} as const;

/** R-NFR-5: revocation spike = recent rate > 5x trailing-1h baseline per chain.
 * The MIN_RECENT floor keeps one or two isolated revocations on a quiet chain
 * from paging: a ratio against a ~zero baseline is not a rate. Dashboard
 * thresholds remain Trevor-owned; both rates ride on the emitted event. */
export const REVOCATION_SPIKE_RATIO = 5;
export const REVOCATION_SPIKE_MIN_RECENT = 3;
export function isRevocationSpike(recentPerMin: number, baselinePerMin: number, recentCount = 0): boolean {
  if (recentCount < REVOCATION_SPIKE_MIN_RECENT) return false;
  if (baselinePerMin <= 0) return true;
  return recentPerMin > REVOCATION_SPIKE_RATIO * baselinePerMin;
}

/** Relayer P&L per tx: absorbed = max(0, actual − attested). Negative absorption is never booked. */
export function absorbedLoss(attested: bigint, actual: bigint | null): bigint {
  if (actual == null) return 0n;
  return actual > attested ? actual - attested : 0n;
}

/**
 * H3 exponential backoff with jitter (R-NFR-7: ≤3 attempts, then park).
 * attempt is 0-based. Returns delay in ms in [base/2, base*2^attempt] capped at maxMs.
 */
export function backoffWithJitter(attempt: number, baseMs = 500, maxMs = 8000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const floor = Math.floor(exp / 2);
  return floor + Math.floor(Math.random() * (exp - floor + 1));
}

/**
 * H3 oracle fallback: when the live fee oracle is unavailable, attest
 * conservatively (the HIGHER of live/last-good, so the tx still lands) while
 * enforcing the 2x gas-sanity bound — estimates beyond 2x last-good fail
 * closed instead of attesting a spike.
 */
export interface OracleFallbackResult {
  ok: boolean;
  attested: bigint;
  reason?: "oracle-unavailable" | "gas-sanity-exceeded";
}
export function applyOracleFallback(
  live: bigint | null,
  lastGood: bigint,
): OracleFallbackResult {
  if (live == null) return { ok: true, attested: lastGood, reason: "oracle-unavailable" };
  if (live > 2n * lastGood) return { ok: false, attested: lastGood, reason: "gas-sanity-exceeded" };
  return { ok: true, attested: live > lastGood ? live : lastGood };
}
