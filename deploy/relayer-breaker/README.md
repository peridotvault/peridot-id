# Relayer circuit-breaker — caps, tuning, rollback (ANT-582)

**Normative basis:** ANT-575 spec rev 3 §3 FR-H H3 + §7 R-NFR-9 (rolling 1 h
absorbed-loss sum per chain; cap values owned by Trevor + CTO = OQ-3).
Mechanism (pause fail-closed + alert + manual resume) ships under ANT-581
(Tyler); this directory owns the **values, the config contract, and the
tuning loop**. Open/close procedure (who may resume, what evidence) is
canonical in `docs/RELAYER_RUNBOOK.md` §4 — this file does not duplicate it.

## Config contract (for the ANT-581 mechanism)

- The mechanism reads caps from env at startup, in **native base units**
  (lamports / stroops / wei, integer strings). Two env families are
  canonical (ANT-601 reconciliation):
  - Mechanism-canonical (repo `PID_*` convention): global default
    `PID_RELAYER_BREAKER_CAP_LAMPORTS` + per-chain override
    `PID_RELAYER_BREAKER_CAP_LAMPORTS_<CHAIN>` (`SOLANA`, `STELLAR`,
    `ETHEREUM`, `BASE`, `BSC`).
  - Ops/alerts alias: `BREAKER_CAP_SOLANA`, `BREAKER_CAP_STELLAR`,
    `BREAKER_CAP_ETHEREUM`, `BREAKER_CAP_BASE`, `BREAKER_CAP_BSC`
    (same names the alert check reads).
- Resolution order, identical on both sides: per-chain `PID_…_<CHAIN>` →
  per-chain `BREAKER_CAP_<CHAIN>` → global `PID_RELAYER_BREAKER_CAP_LAMPORTS`.
  First set, non-empty value wins. Setting either family alone is enough to
  enforce; if both are set for a chain, keep them identical (on disagreement
  the `PID_…_<CHAIN>` value wins on both sides, so the breaker and the page
  still agree). `breaker.config.example.json` maps both families.
- Unset/invalid everywhere = `"0"` = breaker **disabled** for that chain.
  There are NO compiled-in cap defaults: an operator who sets only alert
  thresholds (or nothing at all) gets alerts but no enforcement — the
  pre-ANT-601 README claim that the mechanism "falls back to compiled
  defaults equal to these values" was inaccurate and is withdrawn.
  Deployments MUST export at least one cap family (verified pre-launch with
  Q4 + a `relayer.breaker.opened` drill).
- Rolling window: 1 h (`R-NFR-9`), summed from `relayer.pnl.absorbed` (+ legacy
  `*.reconciled.relayerAbsorbed`) — the same Q4 the alert check evaluates, so
  the breaker and the page can never disagree about the sum.
- Absorbed-loss definition (unchanged): `absorbed = max(0, actual − attested)`
  per sponsored tx. Healthy systems sit near zero; any sustained positive sum
  is either mis-attestation or drain.

## Initial caps (OQ-3 proposal — CTO confirms on ANT-582)

| Chain | Cap / 1 h | In native coin | Rationale |
|---|---|---|---|
| solana | `1,000,000` lamports | 0.001 SOL | ~100–200× typical 5–10k fee |
| stellar | `1,000,000` stroops | 0.1 XLM | ~100× loaded-tx fee (base 100 stroops) |
| ethereum | `20,000,000,000,000,000` wei | 0.02 ETH | ~30× typical 21k-gas tx at 30 gwei |
| base | `500,000,000,000,000` wei | 0.0005 ETH | ~100× typical L2 tx |
| bsc | `2,000,000,000,000,000` wei | 0.002 BNB | ~100× typical 21k-gas tx at 1 gwei |

Blast radius of a wrong cap: too LOW pages/halts on noise (fail-closed =
users re-quote, no fund loss; cost is on-call toil + MTTR on false trips);
too HIGH lets a drain run (fund loss bounded by detection via A4 divergence
alerts + float monitoring). Bootstrap errs toward tight; the 7-day re-tune
(see below) loosens only with data.

## Tuning loop (error budgets)

1. Burn rate is dashboarded (P4 vs cap lines). > 50% of any cap in < 30 min
   pages (A4 80% notify) even before the breaker trips.
2. After 7 days of sustained sponsored traffic: set each cap to
   `100 × p99 single-tx absorbed` observed on that chain, CTO sign-off, record
   in the runbook appendix. No mainnet values change without the audit gate
   (R-NFR-10) and a board order.
3. Threshold/env changes are config-only (no code): update env, restart the
   API workers (rolling, one chain serving at a time), verify with Q4.

## Rollback

- Cap change rollback: restore the previous env values + rolling restart
  (previous values stay in the deploy log / incident thread).
- Breaker misbehavior rollback (false trips): set the affected chain cap to
  the previous value; if the mechanism itself wedges open, the manual-resume
  path in runbook §4 applies (same evidence bar, expedited close with CTO
  named as closer).
- This directory is config + docs only: deleting it changes nothing at
  runtime. The mechanism has NO compiled-in cap defaults (default `"0"` =
  disabled per chain); ANT-601 acceptance checks the both-families contract
  above, including the disabled-by-default behavior.

## Verification (recorded 2026-10-25, scratch Postgres 17)

`relayer-h1-check.sh` Q4 evaluated against seeded `security_events` rows:
absorbed `1,200,000` vs cap `1,000,000` (solana) → PAGE with sum; with a
`relayer.breaker.opened` row present the MECHANISM-GAP note clears; below-cap
sums stay quiet. Full matrix in the ANT-582 thread.
