# Alert: `refresh.reuse_detected` (ANT-246, signal from ANT-241 F4)

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
