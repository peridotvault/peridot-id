-- Alert queries for ANT-246: rate-based paging on
-- security_events rows with eventType = 'refresh.reuse_detected'
-- (signal shipped by ANT-241 F4, peridot-id PR #44).
--
-- READ-ONLY: SELECT only. Safe to run against the deployed DB on a schedule.
-- Run via deploy/alerts/refresh-reuse-check.sh (cron every 5 min).
--
-- Race filter (organic multi-tab races are expected noise — never page on them):
--   a replay is a RACE iff revokedAgoMs <= 30000 AND the replaying userAgent
--   is non-null AND equals the device row's stored userAgent.
--   Everything else (old replay, UA-mismatched, or unclassifiable such as
--   pre-F4 rows with no revokedAgoMs) counts as NON-RACE and is alertable.
--   Missing revokedAgoMs coalesces to +inf so legacy rows fail toward
--   visibility, bounded by the lookback windows below.
--
-- Thresholds (per ANT-246):
--   Q1 GLOBAL: > 5 non-race events per 5 min globally  -> page/notify
--   Q2 DEVICE: > 1 non-race event per device per hour  -> page/notify
--
-- NOTE on Q2 scope: the ticket's ">1 per device per hour" is implemented on
-- the race-filtered set. Two organic races on one device within an hour must
-- not page either, per "do not alert on singles/races".

-- Q1: global non-race count, last 5 minutes. Alert when non_race_events > 5.
SELECT count(*) AS non_race_events
FROM security_events se
LEFT JOIN devices d ON d.id = se.metadata ->> 'deviceId'
WHERE se."eventType" = 'refresh.reuse_detected'
  AND se."createdAt" > now() - interval '5 minutes'
  AND NOT (
    COALESCE((se.metadata ->> 'revokedAgoMs')::bigint, 9223372036854775807) <= 30000
    AND se.metadata ->> 'userAgent' IS NOT NULL
    AND d."userAgent" IS NOT NULL
    AND se.metadata ->> 'userAgent' = d."userAgent"
  );

-- Q2: per-device non-race counts, last hour. Alert when any row is returned
-- (HAVING keeps only devices with more than 1 non-race event).
SELECT
  se.metadata ->> 'deviceId' AS device_id,
  count(*) AS non_race_events
FROM security_events se
LEFT JOIN devices d ON d.id = se.metadata ->> 'deviceId'
WHERE se."eventType" = 'refresh.reuse_detected'
  AND se."createdAt" > now() - interval '1 hour'
  AND NOT (
    COALESCE((se.metadata ->> 'revokedAgoMs')::bigint, 9223372036854775807) <= 30000
    AND se.metadata ->> 'userAgent' IS NOT NULL
    AND d."userAgent" IS NOT NULL
    AND se.metadata ->> 'userAgent' = d."userAgent"
  )
GROUP BY 1
HAVING count(*) > 1;
