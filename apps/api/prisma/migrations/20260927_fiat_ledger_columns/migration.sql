-- DOKU-ledger-first journal: separate payment status, DOKU ledger credit
-- status, and fiat settlement status per movement. All additive, nullable —
-- existing rows and funds are untouched. Backfill policy:
--   ledgerStatus = NULL (unknown — completed by the backfill job per row),
--   settlementStatus = 'settled' where providerStatus = 'settled' (fiat leg
--   already completed), else NULL.

ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "ledgerRef" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "ledgerStatus" TEXT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "settlementStatus" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "pointAccountId" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "lastPointBalance" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "lastPointBalanceAt" TIMESTAMPTZ(3);

UPDATE "fiat_provider_transactions"
SET "settlementStatus" = 'settled'
WHERE "settlementStatus" IS NULL AND "providerStatus" = 'settled';
