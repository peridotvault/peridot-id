# Relayer circuit-breaker — caps, tuning, rollback (ANT-582)

**Normative basis:** ANT-575 spec rev 3 §3 FR-H H3 + §7 R-NFR-9 (rolling 1 h
absorbed-loss sum per chain; cap values owned by Trevor + CTO = OQ-3).
Mechanism (pause fail-closed + alert + manual resume) ships under ANT-581
(Tyler); this directory owns the **values, the config contract, and the
tuning loop**. Open/close procedure (who may resume, what evidence) is
canonical in `docs/RELAYER_RUNBOOK.md` §4 — this file does not duplicate it.

## Config contract (for the ANT-581 mechanism)

- The mechanism reads caps from env at startup, in **native base units**
  (lamports / stroops / wei, integer strings): `BREAKER_CAP_SOLANA`,
  `BREAKER_CAP_STELLAR`, `BREAKER_CAP_ETHEREUM`, `BREAKER_CAP_BASE`,
  `BREAKER_CAP_BSC`. `breaker.config.example.json` is the documented source.
- Rolling window: 1 h (`R-NFR-9`), summed from `relayer.pnl.absorbed` (+ legacy
  `*.reconciled.relayerAbsorbed`) — the same Q4 the alert check evaluates, so
  the breaker and the page can never disagree about the sum.
- Absorbed-loss definition (unchanged): `absorbed = max(0, actual − attested)`
  per sponsored tx. Healthy systems sit near zero; any sustained positive sum
  is either mis-attestation or drain.

## Initial caps (OQ-3 decided — see decision record below)

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
  runtime (mechanism falls back to compiled defaults — which MUST equal these
  values; ANT-581 acceptance checks that).

## Verification (recorded 2026-10-25, scratch Postgres 17)

`relayer-h1-check.sh` Q4 evaluated against seeded `security_events` rows:
absorbed `1,200,000` vs cap `1,000,000` (solana) → PAGE with sum; with a
`relayer.breaker.opened` row present the MECHANISM-GAP note clears; below-cap
sums stay quiet. Full matrix in the ANT-582 thread.

## OQ-3 decision (recorded 2026-10-26, ANT-590)

Decider: board (human) — `ask_user_questions` interaction `40ae650b`,
resolved 2026-10-25 (resolver: human user; individual unnamed, cited as
board-human per attribution rule). Receivers: **CONFIRMED, unchanged**. Caps:
**agreed as conservative bootstrap, numbers unchanged**, finalization subject
to the five conditions dispositioned below. No amended numbers were given, so
`breaker.config.example.json` values stand.

Receivers (confirmed): P1 page → `ALERT_PAGE_URL` on-call
(`formula_mismatch` also pages Security/Tobias); P2 notify →
`ALERT_WEBHOOK_URL` `#relayer-ops`.

Condition dispositions:

1. **Validate each cap vs benchmarked tx costs** — done by analysis, ongoing
   by rule. Cap ≈ tx-equivalents per hour: solana 100–200× typical 5–10k
   lamport tx; stellar ~100× loaded-tx fee (~10,000× 100-stroop base fee);
   ethereum ~30× 21k-gas tx at 30 gwei; base ~100× typical L2 tx;
   bsc ~95× 21k-gas tx at 1 gwei. Durable validation is the 7-day re-tune
   (cap = 100× p99 observed single-tx absorbed, CTO sign-off).
2. **Ethereum fiat exposure reviewed** — acknowledged outlier: 0.02 ETH/hr is
   40× the base cap in the same asset and ≥10× the BSC cap in coin terms
   (per-coin ETH > BNB, so the fiat gap is wider still); orders of magnitude
   above the solana/stellar caps in fiat at any plausible price ratio.
   Mitigation, no value change: bootstrap is testnet-first; no mainnet change
   without the audit gate (R-NFR-10) + board order; ethereum is first in the
   re-tune queue; USD-equivalent monitoring is a tracked follow-up (item 3).
3. **Native + USD monitoring** — gap confirmed: dashboards/alerts/runbook are
   native-units only (no USD coverage in `docs/RELAYER_DASHBOARDS.md`,
   `docs/RELAYER_RUNBOOK.md`, `deploy/dashboards/`). Native-unit breaker + Q4
   alerting ship unchanged; USD-equivalent loss lines are a tracked follow-up
   issue (child of ANT-590).
4. **Caps measure unrecovered losses, not normal gas** — confirmed in code:
   `absorbedLoss(attested, actual) = max(0, actual − attested)`
   (`apps/api/src/relayer/relayer-events.ts`); correctly-attested or
   reimbursed gas books `0`; only positive absorbed feeds `recordAbsorbed`
   (`apps/api/src/relayer/circuit-breaker.service.ts`) and `relayer.pnl`.
5. **Auth / off-chain / non-sponsored unaffected** — confirmed: zero breaker
   references in `auth`/`credentials`/`session-keys`; `requireClosed` gates
   only sponsored broadcast paths (`account/activation`,
   `account/evm-activation`, `wallet/rotate`, `wallet/sponsored-withdraw`).

Known discrepancy (non-blocking, handed to mechanism owner): alert-side env
`BREAKER_CAP_<CHAIN>` (`deploy/alerts/relayer-h1-check.sh`, this file, the
config example) vs mechanism-side `PID_RELAYER_BREAKER_CAP_LAMPORTS[_<CHAIN>]`
(`circuit-breaker.service.ts`, default `"0"` = disabled). Values identical,
names differ; reconcile under a Tyler-owned follow-up (renames need
coordination). Until then operators set BOTH families to the same values,
else the mechanism stays disabled while alerts fire.
