-- Immutable double-entry PTS journal on fiat_provider_transactions.
-- All additive and nullable: existing rows, funds, and history are untouched.
-- Replay folds rows in replaySeq order (never createdAt — clocks tie).
-- Semantics for pre-existing rows (no backfill — replay rules version them):
--   points_issue / points_fee (settled)  -> credit owner (treasury for fee legs
--                                            flagged destination=treasury)
--   transfer_internal (POINT, settled)    -> debit sender gross
--   points_clawback (non-failed)          -> debit user
--   deposit parents / legacy fiat rows    -> fiat intent only, never PTS value
-- New rows carry explicit direction/sourceAccount/destAccount/entryGroup.

ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "direction" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "sourceAccount" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "destAccount" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "entryGroup" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "extinguished" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fiat_provider_transactions' AND column_name = 'replaySeq'
  ) THEN
    ALTER TABLE "fiat_provider_transactions" ADD COLUMN "replaySeq" BIGINT;
    CREATE SEQUENCE IF NOT EXISTS "fiat_provider_transactions_replaySeq_seq";
    ALTER TABLE "fiat_provider_transactions"
      ALTER COLUMN "replaySeq" SET DEFAULT nextval('"fiat_provider_transactions_replaySeq_seq"');
    UPDATE "fiat_provider_transactions" SET "replaySeq" = nextval('"fiat_provider_transactions_replaySeq_seq"');
    ALTER SEQUENCE "fiat_provider_transactions_replaySeq_seq" OWNED BY "fiat_provider_transactions"."replaySeq";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "fiat_provider_transactions_entryGroup_idx"
  ON "fiat_provider_transactions"("entryGroup");
CREATE INDEX IF NOT EXISTS "fiat_provider_transactions_replaySeq_idx"
  ON "fiat_provider_transactions"("replaySeq");
