-- Unify naming: the internal credit journal becomes the fiat ledger, the one
-- balance rail. Pure rename (no data loss): table, indexes, sequence, FK, and
-- the journal kind vocabulary (credit_* -> fiat_*). See docs/INTERNAL_CREDIT.md.

ALTER TABLE "internal_credit_journal" RENAME TO "fiat_ledger_entries";

ALTER INDEX IF EXISTS "internal_credit_journal_pkey" RENAME TO "fiat_ledger_entries_pkey";
ALTER INDEX IF EXISTS "internal_credit_journal_idempotencyKey_key" RENAME TO "fiat_ledger_entries_idempotencyKey_key";
ALTER INDEX IF EXISTS "internal_credit_journal_pid_idx" RENAME TO "fiat_ledger_entries_pid_idx";
ALTER INDEX IF EXISTS "internal_credit_journal_entryGroup_idx" RENAME TO "fiat_ledger_entries_entryGroup_idx";
ALTER INDEX IF EXISTS "internal_credit_journal_pid_status_idx" RENAME TO "fiat_ledger_entries_pid_status_idx";
ALTER INDEX IF EXISTS "internal_credit_journal_replaySeq_idx" RENAME TO "fiat_ledger_entries_replaySeq_idx";
ALTER SEQUENCE IF EXISTS "internal_credit_journal_replaySeq_seq" RENAME TO "fiat_ledger_entries_replaySeq_seq";

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'internal_credit_journal_pid_fkey') THEN
    ALTER TABLE "fiat_ledger_entries" RENAME CONSTRAINT "internal_credit_journal_pid_fkey" TO "fiat_ledger_entries_pid_fkey";
  END IF;
END $$;

UPDATE "fiat_ledger_entries" SET "kind" = replace("kind", 'credit_', 'fiat_') WHERE "kind" LIKE 'credit_%';
