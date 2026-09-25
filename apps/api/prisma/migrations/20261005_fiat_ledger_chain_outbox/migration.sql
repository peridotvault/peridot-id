-- Tamper-evident ledger chain + third-party callback outbox. Additive only.
-- Chain columns are nullable and filled by appendAtPost (and the admin chain
-- backfill for pre-existing rows). See apps/api/src/fiat/fiat-ledger-hash.ts.

ALTER TABLE "fiat_ledger_entries" ADD COLUMN IF NOT EXISTS "prevHash" TEXT;
ALTER TABLE "fiat_ledger_entries" ADD COLUMN IF NOT EXISTS "hash" TEXT;
ALTER TABLE "fiat_ledger_entries" ADD COLUMN IF NOT EXISTS "hashSeq" BIGINT;
CREATE INDEX IF NOT EXISTS "fiat_ledger_entries_hashSeq_idx" ON "fiat_ledger_entries"("hashSeq");

ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "pid_apps" ADD COLUMN IF NOT EXISTS "webhookSecret" TEXT;

CREATE TABLE IF NOT EXISTS "fiat_ledger_events" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "targetPid" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "fiat_ledger_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "fiat_ledger_events_status_nextAttemptAt_idx"
  ON "fiat_ledger_events"("status", "nextAttemptAt");
