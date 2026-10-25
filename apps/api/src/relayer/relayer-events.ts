// Canonical H1/H2/H3 security-event vocabulary for the relayer (ANT-589).
//
// Normative contract (ops half, ANT-582): docs/RELAYER_DASHBOARDS.md §1 event
// table, alert queries in deploy/alerts/relayer-h1-detected.sql, breaker env
// contract in deploy/relayer-breaker/README.md, resume procedure in
// docs/RELAYER_RUNBOOK.md §4.
//
// Rules (the alert SQL matches on these byte-for-byte):
// - exact event names + metadata keys — never rename unilaterally (a rename
//   must land here + in the dashboards doc + the alert SQL + the check script
//   in the SAME PR; contract changes are atomic across both halves).
// - money fields are strings in native base units (lamports / stroops / wei),
//   never floats. No secrets, pids, or amounts in label keys; signatures travel
//   as metadata only where the contract requires them.
// - every breach ALSO writes through the existing security.log path (the
//   SecurityEventService below) — that IS the security_events write.
//
// Rebase note (ANT-598): this file supersedes the PR #107 draft vocabulary
// (`relayer.*` divergence names, `broadcast.*` resolve names,
// `rotation.confirmed_latency`, 11-cause taxonomy, PID_RELAYER_* env). The
// ops revert 56c0adf made this file's names normative; the draft names had
// no monitoring home and are intentionally NOT re-exported. Pure helpers
// from #107 (backoff, oracle fallback, spike predicate) are kept below —
// they carry no event names and remain covered by their specs.

/** Fee chains with sponsored relayer flows (FeeChain; missing → 'unknown'). */
export const FEE_CHAINS = ["solana", "stellar", "ethereum", "base", "bsc"] as const;
export type FeeChain = (typeof FEE_CHAINS)[number];

export function normalizeFeeChain(value: unknown): FeeChain | "unknown" {
  return typeof value === "string" && (FEE_CHAINS as readonly string[]).includes(value)
    ? (value as FeeChain)
    : "unknown";
}

/** EVM decimal chain-id reference → FeeChain (registry references are ids). */
export function evmReferenceToFeeChain(reference: string): FeeChain | "unknown" {
  switch (reference) {
    case "1":
      return "ethereum";
    case "8453":
      return "base";
    case "56":
      return "bsc";
    default:
      return "unknown";
  }
}

/** Sponsored entry points covered per (chain × entryPoint). */
export const SPONSORED_ENTRY_POINTS = ["withdraw", "execute", "rotate", "activate"] as const;
export type SponsoredEntryPoint = (typeof SPONSORED_ENTRY_POINTS)[number];

/** Typed intent-rejection causes (H1.ii) — closed set, exactly as the alerts match. */
export const INTENT_REJECTION_CAUSES = [
  "stale-nonce",
  "expired",
  "drift",
  "policy-unknown",
  "insufficient-funds",
  "unauthorized",
] as const;
export type IntentRejectionCause = (typeof INTENT_REJECTION_CAUSES)[number];

/** Canonical security_events eventType names (H1 i–vi, H2, H3). */
export const RelayerH1Events = {
  credentialRevoked: "credential.revoked",
  credentialRotated: "credential.rotated",
  intentRejected: "intent.rejected",
  formulaMismatch: "reconcile.formula_mismatch",
  overAttested: "reconcile.over_attested",
  pnl: "relayer.pnl",
  driftRejected: "quote.drift_rejected",
  rotationConfirmed: "rotation.confirmed",
  rotationUnconfirmed: "credential.rotation.unconfirmed",
  resolveLanded: "relay.resolve_landed",
  resolveNotLandedRebroadcast: "relay.resolve_not_landed_rebroadcast",
  parkedUnreadable: "relay.parked_unreadable",
  breakerOpened: "relayer.breaker.opened",
  breakerClosed: "relayer.breaker.closed",
} as const;

/** Resolve-then-act outcome labels (H2.v, dashboarded per pid/nonce/chain). */
export const RESOLVE_OUTCOMES = [
  "resolved-landed",
  "resolved-not-landed-rebroadcast",
  "parked-unreadable",
] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

/** Rolling absorbed-loss window for the breaker (R-NFR-9). */
export const BREAKER_WINDOW = "1h";

/** Base-unit money formatting: bigint → decimal string, never a float. */
export function fmtBaseUnits(value: bigint): string {
  return value.toString();
}

/**
 * Relayer P&L per sponsored tx: absorbed = max(0, actual − attested).
 * Negative absorption (relayer profit) is never booked — healthy systems sit
 * near zero; any sustained positive sum is mis-attestation or drain.
 */
export function absorbedLoss(attested: bigint, actual: bigint | null): bigint {
  if (actual == null) return 0n;
  return actual > attested ? actual - attested : 0n;
}

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
