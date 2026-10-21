-- App client-secret expiry policy (ANT-227 item 5). Nullable additive column:
-- existing rows read as NULL (no deadline) until the owner next rotates, so
-- this applies cleanly to any existing database with zero data loss.
-- Down (manual): ALTER TABLE "pid_apps" DROP COLUMN "clientSecretExpiresAt";

ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "clientSecretExpiresAt" TIMESTAMP(3);
