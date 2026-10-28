-- ANT-804 D1-D3: claim idempotency, takedown reports, verification audit (expand-only, backward compatible)
-- New tables + nullable PidApp columns. No data changes: existing apps keep isVerified=false (deny-by-default).

ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "verificationExpiresAt" TIMESTAMPTZ(3);
ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "verifiedBy" TEXT;
ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "verificationJustification" TEXT;

CREATE TABLE IF NOT EXISTS "pid_claim_receipts" (
  "idempotencyKey" TEXT NOT NULL PRIMARY KEY,
  "pid" TEXT NOT NULL,
  "handle" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pid_claim_receipts_pid_idx" ON "pid_claim_receipts"("pid");

CREATE TABLE IF NOT EXISTS "pid_takedown_reports" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "handle" TEXT NOT NULL,
  "normalizedHandle" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "reporterContact" TEXT NOT NULL,
  "reporterPid" TEXT,
  "state" TEXT NOT NULL DEFAULT 'received',
  "decision" TEXT,
  "decidedAt" TIMESTAMPTZ(3),
  "decidedBy" TEXT,
  "appealCount" INTEGER NOT NULL DEFAULT 0,
  "appealedAt" TIMESTAMPTZ(3),
  "transferToPid" TEXT,
  "slaRespondBy" TIMESTAMPTZ(3) NOT NULL,
  "auditSnapshot" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pid_takedown_reports_normalizedHandle_idx" ON "pid_takedown_reports"("normalizedHandle");
CREATE INDEX IF NOT EXISTS "pid_takedown_reports_state_idx" ON "pid_takedown_reports"("state");

CREATE TABLE IF NOT EXISTS "pid_handle_reviews" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "normalizedHandle" TEXT,
  "reason" TEXT NOT NULL,
  "actorRef" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pid_handle_reviews_actorRef_idx" ON "pid_handle_reviews"("actorRef");

CREATE TABLE IF NOT EXISTS "pid_verification_audits" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "justification" TEXT,
  "expiresAt" TIMESTAMPTZ(3),
  "actorPid" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "pid_verification_audits_clientId_idx" ON "pid_verification_audits"("clientId");
