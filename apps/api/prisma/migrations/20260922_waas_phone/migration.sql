-- Store the wallet contact phone (62… international form) on the mapping row.
-- Backfills existing rows from providerResponse.phoneNo where present.

ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "phoneNo" TEXT;

UPDATE "fiat_provider_accounts"
SET "phoneNo" = "providerResponse" ->> 'phoneNo'
WHERE "phoneNo" IS NULL
  AND jsonb_typeof("providerResponse") = 'object'
  AND ("providerResponse" ->> 'phoneNo') IS NOT NULL;
