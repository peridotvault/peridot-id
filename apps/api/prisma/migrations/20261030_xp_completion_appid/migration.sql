-- ANT-430 C1 (plan rev 5 §13, supersedes rev-4 R1): scope completion
-- idempotency per app. Global eventId-only uniqueness allowed cross-app key
-- squatting; the dedup key is now the composite (appId, eventId).
--
-- Additive-only (expand): new NOT NULL column with a backfill default, index
-- swap. No existing table is altered beyond the added column; no data
-- rewritten. Pre-data M1 rows (if any) keep '' (ecosystem scope); new writes
-- always set appId explicitly in the award transaction.
--
-- Down (manual — Prisma has no down-migration runner; additive rollback is
-- code-level: redeploy the previous API build and the column sits unused.
-- To fully revert on a scratch copy:
--   DROP INDEX "xp_task_completions_appId_eventId_key";
--   ALTER TABLE "xp_task_completions" DROP COLUMN "appId";
--   CREATE UNIQUE INDEX "xp_task_completions_eventId_key" ON "xp_task_completions"("eventId");

ALTER TABLE "xp_task_completions" ADD COLUMN "appId" TEXT NOT NULL DEFAULT '';

DROP INDEX "xp_task_completions_eventId_key";

CREATE UNIQUE INDEX "xp_task_completions_appId_eventId_key" ON "xp_task_completions"("appId", "eventId");
