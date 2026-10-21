-- Backfill pre-policy client-secret deadlines (ANT-233 F2). Rows with a secret
-- but NULL expiry (created before the ANT-227 expiry policy) were immortal.
-- Give them the same 365d lifetime from creation; rows with no creation stamp
-- get a 30d grace window from migration time. Secrets already past their
-- deadline fail closed on next use until the owner rotates (uniform
-- "Invalid client" error, no oracle) — that forced rotation is the point.
-- Idempotent and backward-compatible: only touches NULL-expiry secret rows.
-- Down (manual): UPDATE "pid_apps" SET "clientSecretExpiresAt" = NULL
--   WHERE "clientSecretCreatedAt" IS NULL; (cannot distinguish backfilled rows
--   otherwise — prefer a fresh rotation to clear the deadline).

UPDATE "pid_apps"
SET "clientSecretExpiresAt" = CASE
  WHEN "clientSecretCreatedAt" IS NOT NULL THEN "clientSecretCreatedAt" + INTERVAL '365 days'
  ELSE NOW() + INTERVAL '30 days'
END
WHERE "clientSecretHash" IS NOT NULL AND "clientSecretExpiresAt" IS NULL;
