# Deploy alerts (all SELECT-only, cron wrappers, secrets via env)

## Alert: `xp-leveling` (ANT-445, Tobias F5/F7 monitoring requirements)

## What it watches

XP & leveling operability: award volume + single-app concentration,
unreviewed `xp_suspicious_activities` feed (incl. `xp.self_grant` tripwire),
per-app 24h awards vs `xp_quotas.dailyCap`, ledger↔state reconciliation
drift, level-distribution skew, and the throttle/429 probe
(suspicious-feed signal `xp.intake.throttled`, written by the intake
throttle filter on 429s; 0 rows pre-intake = OK).

Thresholds (starting points, env-tunable via `XP_*` vars — tune, don't
hardcode business caps): Q1 > 500 awards/15m; Q2 top app > 80% of 1h awards
(min 50); Q3 > 20 unreviewed/h; Q3b ANY unreviewed `xp.self_grant`/24h;
Q4 ANY app over dailyCap/24h (CRITICAL); Q5 ANY ledger↔state drift
(CRITICAL); Q6 one level > 95% of users (min 100); Q7 > 50 throttles/15m.

## Files

- `xp-leveling-detected.sql` — the canonical alert queries (SELECT-only).
- `xp-leveling-check.sh` — cron wrapper: runs all queries, prints
  `OK:`/`ALERT:`, exits 0/2 (3 = config/query failure). Optional
  `ALERT_WEBHOOK_URL` POSTs the message as `{"text": ...}`.
- `xp-leveling-runbook.md` — triage order + intake kill-switch procedure
  (who flips, expected effect, how to confirm). Every alert links it.

## Enable

Installed automatically: `deploy/alerts/install.sh` adds the 5-min cron line
(scoped per stack via `run-with-infisical.sh`; rollback = remove the cron
line). Rejected/duplicate/retry intake reason-code counts extend the Q-series
once M3 intake ships structured codes (Tyler ANT-441).

## Alert: `refresh.reuse_detected` (ANT-246, signal from ANT-241 F4)

## What it watches

`security_events` rows with `eventType = 'refresh.reuse_detected'`, with the
race filter from the ticket: a replay is an organic multi-tab race (expected
noise — never pages) iff `revokedAgoMs <= 30000` **and** the replaying
`userAgent` equals the device row's stored `userAgent`. Everything else is
alertable.

Thresholds: **> 5 non-race events / 5 min globally**, or **> 1 non-race
event / device / hour** → page/notify.

## Files

- `refresh-reuse-detected.sql` — the two canonical alert queries (SELECT-only).
- `refresh-reuse-check.sh` — cron wrapper: runs both queries, prints
  `OK:`/`ALERT:`, exits 0/2 (3 = config/query failure). Optional
  `ALERT_WEBHOOK_URL` POSTs the message as `{"text": ...}`.

## Enable (ANT-385: automatic)

`deploy/up.sh` calls `deploy/alerts/install.sh <env>` after every deploy —
no manual crontab edit. To install by hand on the VPS:

```sh
./deploy/alerts/install.sh main   # or: test
crontab -l | grep peridot-alert   # verify
```

Each line execs `run-with-infisical.sh`, which pulls `DATABASE_URL` from
Infisical (`/apps/api`, per-stack env) at run time. Rollback:
`crontab -l | grep -v '#peridot-alert' | crontab -`.

Secrets are injected at runtime via `DATABASE_URL` env — never baked into
these files. The check opens a read-only SELECT session; no app, schema, or
data changes.

## Triage

See `docs/SECURITY.md` "SOC runbook — `refresh.reuse_detected`" (ships with
PR #44) for the triage query and reading guide. CAVEAT (flagged to ANT-241
owner 2026-10-21): the runbook draft queries `FROM security_event`
(singular) — the real table is `security_events` (Prisma `@@map`). The alert
SQL here uses the correct name; the runbook needs the one-word fix before merge.

## Verify

Scratch-DB verification (no prod touch), re-runnable:

```bash
docker run --rm -d --name reuse-alert-verify -e POSTGRES_PASSWORD=x -p 5434:5432 postgres:17-alpine
# create minimal security_events/devices tables, seed race + theft rows, run both queries
```

Recorded run 2026-10-21 (scratch Postgres 17, minimal `security_events` /
`devices` tables with production column names):
T1 — 6 same-UA fast replays + 1 lone non-race → `OK`, exit 0 (races excluded,
singles don't page);
T2 — 5 non-race/5min → global quiet, per-device (5/hr one device) fires,
exit 2 (thresholds independent);
T3 — 6th non-race → global + per-device fire, exit 2;
T4 — legacy row without `revokedAgoMs` + null-UA fast replay → both counted
as non-race (fail toward visibility), per-device fires, exit 2.
Unset `DATABASE_URL` → exit 3.

## Rollback

Remove the cron line (or delete `deploy/alerts/`). Nothing was written to
the DB, so there is nothing to undo there.

## Residual

Cron enablement on the VPS + webhook target selection are pending a holder
of deploy access; until then the rule is versioned + verified but not live.

---

## Alert: sandbox faucet abuse (ANT-290, signal from ANT-289 FR-2)

### What it watches

`fiat_ledger_entries` rows with `kind = 'fiat_issue'` and `source = 'faucet'`
(the backend contract: faucet mints travel the corroborated ledger path so
balance/webhook behavior matches real deposits). Only successful mints leave
rows — rejected (422 cap-exceeded) attempts are not counted here.

Thresholds (ANT-287 §6, proposed — CTO confirms via OQ-1): **> 30 mints /
identity / hour** (> 3× daily-cap attempts), or **> 10 mints / Rp100.000 /
identity / 24h** (cap-bypass — cap enforcement failure, critical) →
page/notify. Production runs add the **prod-zero invariant**: ANY
faucet-source row on prod is critical (the route must be absent there, AC-F2).

### Files

- `faucet-abuse-detected.sql` — the three canonical alert queries (SELECT-only).
- `faucet-abuse-check.sh` — cron wrapper: prints `OK:`/`ALERT:`, exits 0/2
  (3 = config/query failure). Optional `ALERT_WEBHOOK_URL` POSTs the message
  as `{"text": ...}`. Env overrides: `ALERT_ENV=sandbox|production`
  (default sandbox), `FAUCET_SOURCE` (default `faucet` — must match the
  backend's `source` string), `FAUCET_HOURLY_MAX` (30),
  `FAUCET_DAILY_MAX_COUNT` (10), `FAUCET_DAILY_MAX_IDR` (100000).

### Enable (ANT-385: automatic)

Same installer as above — `install.sh main` writes the `production` line,
`install.sh test` the `sandbox` line (cadence `*/15` sandbox / `*/5`
production per the thresholds below). Manual cron lines with a pasted
`DATABASE_URL` are not supported: secrets come from Infisical at run time.

Secrets are injected at runtime via `DATABASE_URL` env — never baked into
these files. The check opens a read-only SELECT session; no app, schema, or
data changes.

### Triage

1. Confirm the mint rows: `SELECT pid, count(*), sum("amountIdr") FROM
   fiat_ledger_entries WHERE kind='fiat_issue' AND source='faucet' AND
   "createdAt" > now() - interval '1 hour' GROUP BY 1;`
2. Abuse (one identity hammering) → freeze via `PID_FIAT_LEDGER_FROZEN=true`
   + redeploy, then investigate the caller before unfreezing.
3. Cap-bypass rows (over daily cap) → backend cap bug: hand to BackendEngineer
   with the pid + rows; keep frozen until fixed.
4. Prod-zero hit → faucet route live on prod: set `PID_FAUCET_ENABLED=false`
   + redeploy immediately, treat as incident (no test money may exist on prod).

### Verify

Scratch-DB verification (no prod touch), re-runnable:

```bash
docker run --rm -d --name faucet-alert-verify -e POSTGRES_PASSWORD=x -p 5435:5432 postgres:17-alpine
# create minimal fiat_ledger_entries table, seed faucet + non-faucet rows, run the script
```

Recorded run 2026-10-21 (scratch Postgres 17, minimal
`fiat_ledger_entries` table with production column names):
T1 — 5 faucet mints one identity/hour → `OK`, exit 0;
T2 — 31st mint same hour → hourly ALERT, exit 2;
T3 — 11 small mints spread over 2h (under hourly, over daily count) →
daily cap-bypass ALERT, exit 2;
T4 — non-faucet `fiat_issue` (source `doku`) + old faucet rows outside
windows → ignored, exit 0;
T5 — `ALERT_ENV=production` with one sandbox-era faucet row → PROD-ZERO
ALERT, exit 2; same rows with `ALERT_ENV=sandbox` → `OK`, exit 0.
Unset `DATABASE_URL` → exit 3.

### Rollback

Remove the cron line(s). Nothing was written to the DB, so there is nothing
to undo there.

### Residual

Cron enablement on the VPS + webhook target selection are pending a holder
of deploy access; until then the rule is versioned + verified but not live.
`FAUCET_SOURCE` must match the backend's shipped `source` string (courier
issue to ANT-289 owner carries the contract); thresholds await CTO
confirmation (ANT-287 OQ-1).

---

## Alert: relayer H1 signals (ANT-582, signals from ANT-575 FR-H H1)

### What it watches

`security_events` rows for the relayer hardening event contract (canonical
names + legacy shapes, see `relayer-h1-detected.sql` header and
`docs/RELAYER_DASHBOARDS.md` §1): revocations, intent rejections by cause,
reconciliation divergences, absorbed P&L, drift rejections, rotation
unconfirmed, parked-unreadable, per-chain absorbed sums.

Thresholds (initials; all env-overridable in the script; breaker caps are
OQ-3 = Trevor+CTO, see `deploy/relayer-breaker/README.md`):
revocation spike per chain `recent_10m > prior_50m` (exactly 5× trailing
baseline) with floor `REVOCATION_FLOOR=5` → PAGE; rejections
`REJECT_NOTIFY=10`/`REJECT_PAGE=50` per bucket/15min; ANY divergence/5min →
PAGE (R-NFR-6); absorbed ≥80% cap → NOTIFY, ≥100% → PAGE (R-NFR-9, with a
MECHANISM-GAP note when no `relayer.breaker.opened` exists); rotation stuck
`ROTATION_NOTIFY=3`/`ROTATION_PAGE=10`; ANY parked-unreadable/15min → PAGE;
drift `DRIFT_NOTIFY=20`/`DRIFT_PAGE=100`.

### Files

- `relayer-h1-detected.sql` — the canonical SELECT-only alert queries.
- `relayer-h1-check.sh` — cron wrapper: prints `PAGE:`/`NOTIFY:`/`OK:` lines,
  exits 0/2 (3 = config/query failure). `ALERT_PAGE_URL` (P1, falls back to
  `ALERT_WEBHOOK_URL`) + `ALERT_WEBHOOK_URL` (P2) POST `{"text": ...}`.

### Enable (needs VPS/deploy access — not done from this branch)

```cron
*/5 * * * *  DATABASE_URL='postgresql://...' ALERT_PAGE_URL='...' ALERT_WEBHOOK_URL='...' /opt/peridot-id/deploy/alerts/relayer-h1-check.sh
```

Secrets/thresholds/caps are injected at runtime via env — never baked into
these files. The check opens a read-only SELECT session; no app, schema, or
data changes.

### Triage

Runbook: `docs/RELAYER_RUNBOOK.md` (§1 alert catalog with per-signal example
queries; §2 revocation-spike; §3 divergence; §4 breaker; §5 relayer-key
rotation; §6 post-incident reconcile). Dashboards: `docs/RELAYER_DASHBOARDS.md`
(+ `deploy/dashboards/relayer-h1.json`).

### Verify

Scratch-DB verification (no prod touch), re-runnable: minimal
`security_events` table on scratch Postgres 17, seed rows, run the script.

Recorded run 2026-10-25 (scratch Postgres 17, production column names):
T1 — 1 rotation 30m ago + 1 clean reconciled row → `OK`, exit 0;
T2 — 6 recent solana rotations (prior 1) → PAGE revocation spike, exit 2;
2 recent stellar (below floor) stay quiet;
T3 — legacy `withdraw.reconciled` with `protocolFee≠protocolFeeExpected` →
PAGE divergence, exit 2 (backward-compat path works);
T4 — absorbed 1,200,000 ≥ cap 1,000,000 (solana) → PAGE with MECHANISM GAP
note; parked-unreadable → PAGE; 12 rejections → NOTIFY; 4 unconfirmed →
NOTIFY; 25 drifts → NOTIFY; exit 2;
T5 — `relayer.breaker.opened` present → GAP note clears; unset
`DATABASE_URL` → exit 3.

### Rollback

Remove the cron line (or delete `relayer-h1-*`). Nothing was written to the
DB, so there is nothing to undo there.

### Residual

Cron enablement on the VPS + webhook target selection are pending a holder
of deploy access; until then the rule is versioned + verified but not live.
Canonical event emission lands under ANT-581 (Tyler) per the contract in
`docs/RELAYER_DASHBOARDS.md` §1 — until then the legacy-shape CTEs carry
`credential.rotated`, `*.reconciled`, and `credential.rotation.unconfirmed`
rows. Breaker cap values await CTO confirmation (OQ-3, proposed on ANT-582).
