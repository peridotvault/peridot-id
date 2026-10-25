-- Alert queries for ANT-445: XP & leveling operability paging.
--
-- Signals (backend contract, M1+M2 schema on paperclip @ 929c243):
--   awards             xp_ledger_entries with kind = 'task_award'
--   suspicious feed    xp_suspicious_activities (signal, reviewed, appId)
--   quotas             xp_quotas (dailyCap/weeklyCap/monthlyCap per appId)
--   level distribution user_xp_states (level, totalXp per pid)
--   throttle probe     xp_suspicious_activities with signal =
--                      'xp.intake.throttled' (written by intake-throttle.filter
--                      on 429s; pre-intake reads 0 rows = OK)
--
-- READ-ONLY: SELECT only. Safe to run against the deployed DB on a schedule.
-- Run via deploy/alerts/xp-leveling-check.sh (cron every 5 min).
--
-- Thresholds (Tobias F5/F7 monitoring requirements; starting points only —
-- tune per environment via the check script env vars, never hardcode
-- business caps into app code):
--   Q1 AWARD-SPIKE:   > 500 task_awards per 15 min globally      -> page/notify
--   Q2 CONCENTRATION: top app > 80% of 1h awards (min 50 awards) -> page/notify
--   Q3 SUSPICIOUS:    > 20 unreviewed signals per 1h            -> page/notify
--   Q3b SELF-GRANT:   ANY unreviewed signal='xp.self_grant'     -> page/notify
--                      (F3 self-approval control tripwire)
--   Q4 QUOTA-BREACH:  ANY app over its dailyCap per 24h         -> CRITICAL
--                      (cap enforcement failure — bug or abuse)
--   Q5 LEDGER-DRIFT:  sum(ledger.deltaXp) != sum(state.totalXp) -> CRITICAL
--                      (reconciliation invariant; migration-safety tripwire)
--   Q6 LEVEL-SKEW:    one level holds > 95% of users (min 100)  -> page/notify
--                      (curve/policy-config bug tripwire)
--   Q7 THROTTLE-SPIKE: > 50 throttle-feed rows per 15 min       -> page/notify
--                      (F5 429-spike; source = suspicious feed signal
--                      'xp.intake.throttled', 0 pre-intake = OK)
--
-- NOTE: rejected/duplicate/retry intake attempts leave no ledger row until
-- M3 intake ships structured reason codes (Tyler ANT-441). Until then Q3's
-- suspicious feed is the rejection-visibility proxy; extend Q-series with
-- intake reason-code counts once that table/column contract lands.

-- Q1: global task_award volume, last 15 minutes. Alert when count > 500.
SELECT count(*) AS awards_15m
FROM xp_ledger_entries
WHERE kind = 'task_award'
  AND "createdAt" > now() - interval '15 minutes';

-- Q2: per-app task_award counts, last hour (shell computes top share).
-- Alert when total >= 50 AND top app share > 80%.
SELECT "appId", count(*) AS awards_1h
FROM xp_ledger_entries
WHERE kind = 'task_award'
  AND "createdAt" > now() - interval '1 hour'
GROUP BY 1
ORDER BY 2 DESC;

-- Q3: unreviewed suspicious-activity count, last hour. Alert when > 20.
SELECT count(*) AS suspicious_1h
FROM xp_suspicious_activities
WHERE reviewed = false
  AND "createdAt" > now() - interval '1 hour';

-- Q3b: unreviewed self-grant tripwires, last 24h. Alert on ANY row.
SELECT id, "appId", pid, "createdAt"
FROM xp_suspicious_activities
WHERE reviewed = false
  AND signal = 'xp.self_grant'
  AND "createdAt" > now() - interval '24 hours'
ORDER BY "createdAt" DESC
LIMIT 20;

-- Q4: per-app 24h awards vs dailyCap. Alert on ANY row (breach = CRITICAL).
SELECT
  a."appId" AS app_id,
  count(*) AS awards_24h,
  max(q."dailyCap") AS daily_cap
FROM xp_ledger_entries a
JOIN xp_quotas q ON q."appId" = a."appId"
WHERE a.kind = 'task_award'
  AND a."createdAt" > now() - interval '24 hours'
  AND q."dailyCap" IS NOT NULL
GROUP BY a."appId"
HAVING count(*) > max(q."dailyCap");

-- Q5a: global ledger-vs-state reconciliation. Breach when the two differ.
SELECT
  (SELECT coalesce(sum("deltaXp"), 0) FROM xp_ledger_entries) AS ledger_sum,
  (SELECT coalesce(sum("totalXp"), 0) FROM user_xp_states) AS state_sum;

-- Q5b: per-pid drift sample (200 most recently updated states).
-- Breach on ANY row. Bounded: indexed order + LIMIT, no full-table join.
SELECT
  s.pid,
  s."totalXp" AS state_total,
  coalesce(l.ledger_total, 0) AS ledger_total
FROM (
  SELECT pid, "totalXp"
  FROM user_xp_states
  ORDER BY "updatedAt" DESC
  LIMIT 200
) s
LEFT JOIN (
  SELECT pid, sum("deltaXp") AS ledger_total
  FROM xp_ledger_entries
  WHERE pid IN (SELECT pid FROM user_xp_states ORDER BY "updatedAt" DESC LIMIT 200)
  GROUP BY pid
) l ON l.pid = s.pid
WHERE coalesce(l.ledger_total, 0) <> s."totalXp";

-- Q6: level distribution (shell computes max share).
-- Alert when users >= 100 AND one level holds > 95%.
SELECT level, count(*) AS users
FROM user_xp_states
GROUP BY 1
ORDER BY 1;

-- Q7: throttle/429 probe, last 15 minutes. Alert when count > 50.
-- Source is the SUSPICIOUS FEED (intake-throttle.filter writes
-- signal='xp.intake.throttled' rows on 429s), NOT security_events (no
-- emitter there). Pre-intake this reads 0 rows — OK by construction.
SELECT count(*) AS throttles_15m
FROM xp_suspicious_activities
WHERE signal = 'xp.intake.throttled'
  AND "createdAt" > now() - interval '15 minutes';
