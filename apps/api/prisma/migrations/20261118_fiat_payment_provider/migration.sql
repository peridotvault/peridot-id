-- Provider routing on money-in intents (stage 3 of docs/plan/03).
-- Existing rows were all DOKU, so the default both backfills and documents them.
ALTER TABLE "fiat_payments" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'doku-checkout';
