-- Alert queries for ANT-290: faucet-abuse paging on fiat_ledger_entries.
--
-- Signal (backend contract, ANT-289 FR-2): faucet mints land via the existing
-- corroborated ledger path with kind = 'fiat_issue' AND source = 'faucet'.
-- If the backend ships a different source string, set FAUCET_SOURCE in the
-- check script env — the shape of these queries does not change.
--
-- READ-ONLY: SELECT only. Safe to run against the deployed DB on a schedule.
-- Run via deploy/alerts/faucet-abuse-check.sh (cron every 15 min sandbox,
-- every 5 min production where ANY faucet row is a critical finding).
--
-- Thresholds (ANT-287 §6, proposed — CTO confirms via OQ-1):
--   daily cap: 10 calls / Rp100.000 per identity per day
--   Q1 ABUSE:     > 30 faucet mints per identity per hour (> 3x daily-cap
--                 attempts) -> page/notify
--   Q2 CAP-BYPASS: > 10 mints OR > Rp100.000 per identity per 24h -> page/notify
--                 (cap enforcement failure — critical, possible bug or abuse)
--   Q3 PROD-ZERO: ANY faucet-source row, ever -> CRITICAL on production
--                 (route must be absent there; AC-F2). On sandbox Q3 is
--                 informational only (faucet is supposed to mint there).
--
-- NOTE: only successful mints write ledger rows. Rejected (422 cap-exceeded)
-- attempts leave no row here; if the backend later logs rejections to
-- security_events, extend Q1 with that source. Until then this alert counts
-- mints, which is the money truth.

-- Q1: per-identity faucet mints, last hour. Alert when any row is returned
-- (HAVING keeps only identities above the hourly max).
SELECT
  pid,
  count(*) AS mints_1h,
  coalesce(sum("amountIdr"), 0) AS idr_1h
FROM fiat_ledger_entries
WHERE kind = 'fiat_issue'
  AND source = 'faucet'
  AND "createdAt" > now() - interval '1 hour'
GROUP BY 1
HAVING count(*) > 30;

-- Q2: per-identity faucet mints, last 24h. Alert when any row is returned
-- (HAVING keeps identities over the daily count OR daily amount cap).
SELECT
  pid,
  count(*) AS mints_24h,
  coalesce(sum("amountIdr"), 0) AS idr_24h
FROM fiat_ledger_entries
WHERE kind = 'fiat_issue'
  AND source = 'faucet'
  AND "createdAt" > now() - interval '24 hours'
GROUP BY 1
HAVING count(*) > 10 OR coalesce(sum("amountIdr"), 0) > 100000;

-- Q3: all-time faucet rows (prod-zero invariant). Alert when count > 0 AND
-- the checker runs with ALERT_ENV=production; sandbox runs report it only.
SELECT count(*) AS faucet_rows_all_time
FROM fiat_ledger_entries
WHERE kind = 'fiat_issue'
  AND source = 'faucet';
