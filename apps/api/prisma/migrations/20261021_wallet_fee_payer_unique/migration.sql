-- Wallet audit (ANT-247): one address registers at most once per chain account.
-- Duplicate fee-payer rows would let the same address be counted/authorized twice.
-- No code writes wallet_fee_payers yet (schema-only surface), so no backfill is needed;
-- the statement fails loudly (no silent dedupe) if duplicates already exist.
-- Down (manual): DROP INDEX IF EXISTS "wallet_fee_payers_chainAccountId_address_key";

-- De-duplicate defensively first: keep the earliest row per (chainAccountId, address).
DELETE FROM "wallet_fee_payers" a USING "wallet_fee_payers" b
WHERE a."id" > b."id"
  AND a."chainAccountId" = b."chainAccountId"
  AND a."address" = b."address";

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_fee_payers_chainAccountId_address_key"
  ON "wallet_fee_payers"("chainAccountId", "address");
