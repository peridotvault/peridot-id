-- Temporary Internal Credit Ledger (Rail B). Additive only: no existing
-- table is touched. Postgres is the temporary truth for this rail;
-- DOKU Checkout stays the money-in source. See docs/INTERNAL_CREDIT.md.
-- Immutable double-entry journal: one logical movement = one entryGroup.
-- Only `posted` rows count in replay (never createdAt — replaySeq orders).

CREATE TABLE IF NOT EXISTS "internal_credit_accounts" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_credit_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "internal_credit_accounts_pid_key"
  ON "internal_credit_accounts"("pid");

CREATE TABLE IF NOT EXISTS "internal_credit_journal" (
  "id" TEXT NOT NULL,
  "entryGroup" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "counterpartyPid" TEXT,
  "amountIdr" BIGINT NOT NULL,
  "direction" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "parentRef" TEXT,
  "status" TEXT NOT NULL DEFAULT 'created',
  "feePolicyVersion" INTEGER,
  "counterparty" JSONB,
  "source" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "internal_credit_journal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "internal_credit_journal_idempotencyKey_key"
  ON "internal_credit_journal"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "internal_credit_journal_pid_idx"
  ON "internal_credit_journal"("pid");
CREATE INDEX IF NOT EXISTS "internal_credit_journal_entryGroup_idx"
  ON "internal_credit_journal"("entryGroup");
CREATE INDEX IF NOT EXISTS "internal_credit_journal_pid_status_idx"
  ON "internal_credit_journal"("pid", "status");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'internal_credit_journal' AND column_name = 'replaySeq'
  ) THEN
    ALTER TABLE "internal_credit_journal" ADD COLUMN "replaySeq" BIGINT;
    CREATE SEQUENCE IF NOT EXISTS "internal_credit_journal_replaySeq_seq";
    ALTER TABLE "internal_credit_journal"
      ALTER COLUMN "replaySeq" SET DEFAULT nextval('"internal_credit_journal_replaySeq_seq"');
    UPDATE "internal_credit_journal" SET "replaySeq" = nextval('"internal_credit_journal_replaySeq_seq"');
    ALTER SEQUENCE "internal_credit_journal_replaySeq_seq" OWNED BY "internal_credit_journal"."replaySeq";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "internal_credit_journal_replaySeq_idx"
  ON "internal_credit_journal"("replaySeq");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_credit_accounts_pid_fkey'
  ) THEN
    ALTER TABLE "internal_credit_accounts" ADD CONSTRAINT "internal_credit_accounts_pid_fkey"
      FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_credit_journal_pid_fkey'
  ) THEN
    ALTER TABLE "internal_credit_journal" ADD CONSTRAINT "internal_credit_journal_pid_fkey"
      FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
