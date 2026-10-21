-- Client-secret rotation grace window (ANT-283). Nullable additive columns:
-- existing rows read as NULL (no previous secret) so this applies cleanly to
-- any existing database with zero data loss. The previous hash keeps
-- verifying until its overlap deadline (APP_CLIENT_SECRET_GRACE, 24h).
-- Down (manual): ALTER TABLE "pid_apps" DROP COLUMN "prevClientSecretHash",
--   DROP COLUMN "prevClientSecretExpiresAt";

ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "prevClientSecretHash" TEXT;
ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "prevClientSecretExpiresAt" TIMESTAMP(3);
