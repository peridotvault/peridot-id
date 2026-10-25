# PeridotID Relayer Runbook (ANT-582 · H4)

**Normative basis:** ANT-575 spec rev 3 §3 FR-H (H4) + §7 R-NFR-5–9,11. Parent: ANT-542 (P0a, board-APPROVED 2026-10-25).
**Scope:** testnet/devnet + staging. No mainnet action without an external human audit gate (R-NFR-10) and a board order.
**Lenses:** Blast radius · Rollback path · Error budgets · Canary vs full deploy · MTTR · Observability-before-launch · Least-privilege IAM · Secrets injected at runtime · Runbook hygiene.

**Where things live**

| Surface | Pointer |
|---|---|
| Alert SQL (canonical) | `deploy/alerts/relayer-h1-detected.sql` (+ USD lens `relayer-usd-detected.sql`, §7) |
| Alert check (cron, 5 min) | `deploy/alerts/relayer-h1-check.sh` (exit 0/2/3; `PAGE:`/`NOTIFY:` stdout split) + `relayer-usd-check.sh` (same convention, USD lens + staleness gate, §7) |
| Dashboard queries + panel map | `docs/RELAYER_DASHBOARDS.md` (+ importable `deploy/dashboards/relayer-h1.json`) |
| Breaker caps + tuning | `deploy/relayer-breaker/` (`breaker.config.example.json`, `README.md`) |
| Event contract (backend emits) | `docs/RELAYER_DASHBOARDS.md` §1 (implemented under ANT-581) |

**First-5-minutes triage (any PAGE):** (1) note chain + signal from the alert line;
(2) open the dashboard panel for that signal (§1 below); (3) run the Example query
to confirm it is still firing; (4) jump to the matching playbook (§2–§6). Do not
restart, redeploy, or rotate anything before step 4 names the action — MTTR comes
from correct first action, not first action.

---

## 1. Alert catalog

Severity: **P1 PAGE** = wake the on-call, act now. **P2 NOTIFY** = act within the
business day. Receivers: P1 → on-call primary via `ALERT_PAGE_URL` (PagerDuty/
Opsgenie webhook; falls back to `ALERT_WEBHOOK_URL`); P2 → `#relayer-ops` via
`ALERT_WEBHOOK_URL`. `formula_mismatch` pages **Security (Tobias) in addition**
to on-call. Every breach also writes a `security.log` event (backend, ANT-581).

| # | Signal (H1) | Severity | Receiver | Threshold (initial; env-overridable) | Example query |
|---|---|---|---|---|---|
| A1 | Revocation spike (R-NFR-5) | P1 | on-call | per chain: `recent_10m > prior_50m` (= 5× trailing baseline) AND `recent_10m ≥ 5` | `SELECT COALESCE(metadata->>'chain','unknown'), COUNT(*) FILTER (WHERE "createdAt" > now()-interval'10m'), COUNT(*) FILTER (WHERE "createdAt" <= now()-interval'10m') FROM security_events WHERE "eventType" IN ('credential.rotated','credential.revoked') AND "createdAt" > now()-interval'1h' GROUP BY 1;` |
| A2 | Intent rejections by cause | P2 ≥10 / P1 ≥50 per (chain,entryPoint,cause)/15min | on-call (P1) / #relayer-ops (P2) | `REJECT_NOTIFY=10`, `REJECT_PAGE=50` | `SELECT metadata->>'cause', COUNT(*) FROM security_events WHERE "eventType"='intent.rejected' AND "createdAt" > now()-interval'15m' GROUP BY 1;` — cause ∈ `stale-nonce\|expired\|drift\|policy-unknown\|insufficient-funds\|unauthorized` |
| A3 | Reconciliation divergence (R-NFR-6) | **P1** (any event/5min) | on-call **+ Security** for `formula_mismatch`; on-call for `over_attested` | any `formula_mismatch`/`over_attested` (or legacy `*.reconciled` with `overAttested=true` or `protocolFee≠protocolFeeExpected`) in 5 min | `SELECT "eventType", metadata->>'chain', metadata FROM security_events WHERE "createdAt" > now()-interval'5m' AND ("eventType" IN ('reconcile.formula_mismatch','reconcile.over_attested') OR ("eventType" LIKE '%.reconciled' AND (COALESCE((metadata->>'overAttested')::boolean,false) OR (metadata->>'protocolFee') IS DISTINCT FROM (metadata->>'protocolFeeExpected'))));` |
| A4 | Relayer absorbed loss vs breaker cap (R-NFR-9) | P2 at 80% of cap; **P1** at 100% | on-call | rolling-1h `SUM(absorbed)` per chain vs `BREAKER_CAP_*` (§4) | Q4 in `relayer-h1-detected.sql`. A P1 **without** a `relayer.breaker.opened` row for the chain in the window is a MECHANISM GAP — treat as P1 + file a bug on the breaker (backend, ANT-581 mechanism) |
| A5 | Rotation stuck (`rotation.unconfirmed`) | P2 ≥3 / P1 ≥10 per chain/15min | on-call (P1) / #relayer-ops (P2) | `ROTATION_NOTIFY=3`, `ROTATION_PAGE=10` | `SELECT metadata->>'chain', COUNT(*) FROM security_events WHERE "eventType" IN ('credential.rotation.unconfirmed','rotation.unconfirmed') AND "createdAt" > now()-interval'15m' GROUP BY 1;` |
| A6 | Resolve-then-act `parked-unreadable` | **P1** (any event/15min; never auto-clears) | on-call | any | `SELECT metadata->>'chain', metadata->>'entryPoint', metadata->>'nonce', metadata->>'signature' FROM security_events WHERE "eventType"='relay.parked_unreadable' AND "createdAt" > now()-interval'15m';` |
| A7 | Quote-drift spike (`quote.drift_rejected`) | P2 ≥20 / P1 ≥100 per (chain,entryPoint)/15min | on-call (P1) / #relayer-ops (P2) | `DRIFT_NOTIFY=20`, `DRIFT_PAGE=100` | `SELECT metadata->>'chain', metadata->>'entryPoint', COUNT(*) FROM security_events WHERE "eventType"='quote.drift_rejected' AND "createdAt" > now()-interval'15m' GROUP BY 1,2;` |
| A8 | Relayer absorbed loss in USD + price-feed staleness (R-NFR-9 USD lens, ANT-602) | P2 at 80% of USD cap; **P1** at 100%; **P1** on stale/missing rate for any chain with 1h traffic | on-call (staleness pages on-call only, never Security) | rolling-1h absorbed-USD per chain vs `USD_CAP_*`; rate age vs `PRICE_STALE_AFTER_SEC` (default 900 s) | Q8 in `relayer-usd-detected.sql` (check: `relayer-usd-check.sh`). Same MECHANISM-GAP note as A4. Stale = fail-closed page + USD eval skipped (native A4 still paging) |

Cron latency note: the check runs every 5 min; worst-case detection latency ≈
interval + runtime, inside the R-NFR-5/6 ≤ 5 min bound. If cron stalls > 10 min,
treat the *absence of OK lines* as an alert (dead-man: monitor the cron log).

---

## 2. Revocation-spike playbook (A1)

Goal: distinguish **user-driven rotation waves** (benign: feature launch, wallet
UX nudging rotations, testnet scripts) from **compromise waves** (one actor
rotating many victims, or many rotations from few devices/IPs), then freeze or
observe accordingly.

1. Confirm still firing: re-run the A1 example query. Note chain(s) + magnitude.
2. Wave-shape query (rotation wave vs compromise):
   ```sql
   SELECT date_trunc('minute',"createdAt") AS m, COUNT(*),
          COUNT(DISTINCT pid) AS pids,
          COUNT(DISTINCT metadata->>'signature') AS sigs
   FROM security_events
   WHERE "eventType" IN ('credential.rotated','credential.revoked')
     AND "createdAt" > now() - interval '30 minutes'
   GROUP BY 1 ORDER BY 1;
   ```
   - **Rotation wave (observe):** `pids ≈ events`, spread over minutes, normal
     entry-point mix, no rejection surge (A2 quiet), no divergence (A3 quiet).
     Action: keep observing; post a P2 note; check with Product whether a
     launch/campaign explains it. Do NOT freeze.
   - **Compromise wave (freeze path):** `pids` concentrated, bursts in single
     minutes, same `entryPoint`, accompanying A2 `unauthorized` surge or A6
     parks, or rotations on chains the users never used. Action: escalate to
     P1, page Security (Tobias), and freeze new grants: set the sponsored-broadcast
     kill flag for the affected chain(s) (see §4 procedure — same mechanism as
     the breaker, manual close), then follow the breaker-resume evidence bar
     before reopening.
3. Freeze-vs-observe rule: **observe** when per-pid rate is normal and no
   companion signal (A2/A3/A6) fires; **freeze** (per-chain sponsored-broadcast
   halt + Security page) on any companion signal or per-pid concentration.
   Freezing is fail-closed for users: the re-quote path keeps serving, so
   legitimate users see "try again in a moment", not lost funds.
4. Close-out: incidents close only after §6 verification. Record the wave shape
   + decision + who decided in the incident thread (attribution honesty: name
   the decider).

## 3. Divergence playbook (A3)

Two sub-cases, different severity:

- **`formula_mismatch`** (`protocolFee ≠ formula(networkFee)`): the on-chain
  program's rate and the attested number disagree. **Halt + Security page.**
  (1) Page Security (Tobias) + on-call. (2) Halt sponsored broadcasts on the
  affected chain(s) via the breaker-manual-open path (§4). (3) Pull the four
  fee fields from the alert row (`attested`, `actual`, `expected`,
  `protocolFee`) and hand them to Backend + Security — do NOT resume until the
  formula source (contract vs attester) is identified. (4) Blast radius: only
  the affected chain halts; other chains keep serving. Rollback: resume per §4
  evidence bar. This is the one divergence that implies a trust-boundary
  failure — treat every instance as a security incident until proven otherwise.
- **`over_attested`** (attested > 120% of actual; relayer overpays users'
  costs): **relayer top-up + quote review, no halt.** (1) Check relayer float
  for the chain (dashboard panel P&L; alert if float < 2× hourly attestation
  rate). (2) Top up the relayer key from the float reserve. (3) File a quote-
  parameter review (attestation source / oracle lag — same root-cause family
  as A7 drift). (4) If `over_attested` persists > 1 h after top-up, escalate to
  P1: persistent over-attestation at volume is economically equivalent to a
  drain (see §4 caps).

## 4. Circuit-breaker open/close procedure

Mechanism (backend, ANT-581): per-chain spend-rate breaker on absorbed-loss
rolling window; opens fail-closed (sponsored broadcasts pause, re-quote path
serves), pages per A4. Cap values + tuning: `deploy/relayer-breaker/`.

- **Who may open:** automatic (mechanism) or any on-call manually (freeze path
  from §2/§3). Manual open writes the reason in the incident thread.
- **Who may resume (close):** on-call primary **plus** one of CTO (Axel) or
  Security (Tobias) for `formula_mismatch`-triggered opens; on-call alone may
  resume `over_attested`/cap-only opens. No self-approval: the person who
  opened for a security reason cannot be the sole closer.
- **Evidence required to close:** (a) root cause named (quote bug, oracle
  outage, fee spike, abuse); (b) A3 quiet for 30 min on the chain; (c) A4 sum
  back under 50% of cap; (d) relayer float topped up; (e) §6 post-incident
  reconcile re-run over the incident window passes. Paste all five into the
  incident thread; the closer names themselves.
- **Rollback path:** resume is itself reversible — if A3/A4 re-fire within
  30 min of resume, the breaker re-opens automatically and the incident
  re-opens at P1. Manual rollback of a bad resume = re-halt the chain
  (same flag as open) + page.
- **Error budget:** the caps ARE the budget (max hourly absorbed loss per
  chain). Exhaustion rate is dashboarded; burning > 50% of any cap in
  < 30 min pages even before the breaker trips (A4 80% notify).

## 5. Relayer-key rotation procedure

(Distinct from user-authority rotation. Least-privilege: the relayer key only
ever sponsors whitelisted entry points; it holds no user assets.)

1. Provision the replacement key in the secret store (runtime injection —
   never in repo, logs, or dashboards). Reference secret *names* only.
2. Fund the replacement with 2× the chain's hourly attestation rate (see
   dashboard P&L panel), verify float on-chain.
3. Switch the serving config to the new key reference (config change, not code;
   canary: one chain first, watch A4/A5 for 15 min, then remaining chains).
4. Confirm sponsored traffic lands under the new key (dashboard submissions
   panel), then drain + decommission the old key (zero balance, revoke from
   the allowlist, rotate the stored secret version).
5. Rollback: the old key stays funded-but-decommissioned for 24 h; re-point
   config to it if the new key fails to land transactions.
6. Log start/finish as `security.log` events (backend) so rotation windows
   are visible in the dashboard.

## 6. Post-incident reconcile verification

No incident closes without this:

1. Re-run reconciliation over the incident window per chain:
   ```sql
   SELECT "eventType", COUNT(*),
          COALESCE(SUM((metadata->>'absorbed')::numeric),0) AS absorbed_total
   FROM security_events
   WHERE "createdAt" BETWEEN '<incident-start>' AND '<incident-end>'
     AND (metadata->>'chain' = '<chain>' OR '<chain>' = 'all')
     AND ("eventType" LIKE '%.reconciled' OR "eventType" IN
          ('relayer.pnl','reconcile.formula_mismatch','reconcile.over_attested'))
   GROUP BY 1;
   ```
   plus the resolve-then-act outcome breakdown (Q6b in `relayer-h1-detected.sql`):
   every `open` intent from the window must end `resolved-landed`,
   `resolved-not-landed-rebroadcast`, or `parked-unreadable` with an operator
   note — zero intents left ambiguous.
2. Confirm absorbed totals reconcile against the relayer float delta for the
   window (dashboard P&L panel). Unexplained delta → re-open at P1.
3. Update the runbook appendix (below) with the incident date, signal, cause,
   and any threshold change. Threshold changes need CTO sign-off (OQ-3 owners).

## 7. USD burn + price-feed staleness playbook (A8, ANT-602)

Two sub-cases, different first actions. In BOTH cases the native-unit A4 keeps
paging underneath — the USD lens never gates the breaker.

- **USD burn page (loss ≥ 100% of `USD_CAP_*`, rate fresh):** treat exactly like
  an A4 page (§4): the dollar lens caught what the native lens also sees (or a
  price spike repriced the same base-unit loss over the cap). Same breaker
  open/close procedure, same evidence bar, same MECHANISM-GAP rule (a USD page
  without a `relayer.breaker.opened` row = P1 + breaker bug filed). Close-out
  per §6, quoting BOTH the native sum and the USD sum in the incident thread.
- **Staleness page (no/missing-old rate for a chain WITH 1h traffic):**
  fail-closed triage, not a loss event — yet:
  1. Confirm: `SELECT chain, asof, now() − asof AS age, source FROM
     relayer_price_rates;` + check the price-refresh job log (5-min cron).
     Note which chains are stale and whether ANY chain is affected (all-stale
     = feed or key outage; single-chain = vendor symbol/rate-limit issue).
  2. Blast radius: the USD lens is blind for the stale chains; native A4 is
     the backstop — verify A4 is quiet-or-handled for those chains before
     doing anything else. Never "estimate" the USD loss by hand-pricing;
     quote the native sum only.
  3. Fix the feed first: check `PRICE_API_KEY` rotation/expiry and vendor
     status; re-run the refresh job; confirm `asof` advances and the A8 page
     clears on the next 5-min tick. Do NOT silence A8 while the feed is down
     (the page IS the monitoring while blind).
  4. Secrets hygiene: the key lives in Infisical `/apps/api` as `PRICE_API_KEY`
     (runtime-injected, same path as the alert checks). Paste secret *names*
     only in the incident thread — never values.
  5. MTTR note: three missed refreshes (15 min) is the page bound. If the feed
     cannot recover within the hour, escalate to P1 with the native A4 sums as
     the loss evidence and treat USD blindness as a monitoring incident.
- **Refresh-job ownership:** the 5-min price refresh is operator-owned (Trevor);
  vendor failover (second feed as `source`) is a follow-up, not this change.
  Until failover exists, any single-vendor outage pages — that is the intended
  fail-closed behavior, not noise to tune away.

### Appendix: incident log

| Date | Signal | Chain | Cause | Action | Threshold change |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
