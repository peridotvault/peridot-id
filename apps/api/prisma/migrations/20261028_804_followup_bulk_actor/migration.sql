-- ANT-826 (ANT-825 follow-up): D2.1 per-actor bulk flag + F5 takedown hardening.
-- Expand-only, backward compatible: nullable/new columns + indexes only, no data
-- changes, no NOT NULL, no drops. Old rows keep NULL actorRef / NULL verifiedAt.
ALTER TABLE "pid_claim_receipts" ADD COLUMN IF NOT EXISTS "actorRef" TEXT;
CREATE INDEX IF NOT EXISTS "pid_claim_receipts_actorRef_idx" ON "pid_claim_receipts"("actorRef");

ALTER TABLE "pid_takedown_reports" ADD COLUMN IF NOT EXISTS "reporterContactVerifiedAt" TIMESTAMPTZ(3);
CREATE INDEX IF NOT EXISTS "pid_takedown_reports_reporterPid_idx" ON "pid_takedown_reports"("reporterPid");
