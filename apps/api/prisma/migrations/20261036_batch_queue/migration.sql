-- Phase-1a intent queue (ANT-762). Expand-only: brand-new table, no changes
-- to existing tables, no data movement. Safe to apply on a live database.
CREATE TABLE "queued_batches" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "atomic" BOOLEAN NOT NULL DEFAULT true,
  "ops" JSONB NOT NULL,
  "quoteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "quotedBaseline" BIGINT NOT NULL,
  "quotedMaxTotal" BIGINT NOT NULL,
  "feePolicyVersion" INTEGER NOT NULL,
  "sessionExpiresAt" TIMESTAMPTZ(3),
  "validUntil" TIMESTAMPTZ(3),
  "bypassQueue" BOOLEAN NOT NULL DEFAULT false,
  "receipts" JSONB,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "settleDueAt" TIMESTAMPTZ(3) NOT NULL,
  "settledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "queued_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "queued_batches_idempotencyKey_key" ON "queued_batches"("idempotencyKey");
CREATE INDEX "queued_batches_pid_idx" ON "queued_batches"("pid");
CREATE INDEX "queued_batches_status_idx" ON "queued_batches"("status");
CREATE INDEX "queued_batches_settleDueAt_idx" ON "queued_batches"("settleDueAt");
