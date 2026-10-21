# Deploy alerts (all SELECT-only, cron wrappers, secrets via env)

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

## Enable (needs VPS/deploy access — not done from this branch)

```cron
*/5 * * * *  DATABASE_URL='postgresql://...' /opt/peridot-id/deploy/alerts/refresh-reuse-check.sh
```

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

### Enable (needs VPS/deploy access — not done from this branch)

```cron
*/15 * * * *  DATABASE_URL='postgresql://...' ALERT_ENV=sandbox    /opt/peridot-id/deploy/alerts/faucet-abuse-check.sh
*/5  * * * *  DATABASE_URL='postgresql://...' ALERT_ENV=production /opt/peridot-id/deploy/alerts/faucet-abuse-check.sh
```

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
