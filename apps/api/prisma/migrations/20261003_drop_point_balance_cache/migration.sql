-- Drop the DOKU POINT balance cache columns. They were written by balance()
-- but never read (the DOKU Unified Ledger rail is frozen and we run our own
-- internal-credit ledger; DOKU is always read live for the POINT rail).
-- Additive-safe: pure cache, no history lost.

ALTER TABLE "fiat_provider_accounts" DROP COLUMN IF EXISTS "lastPointBalance";
ALTER TABLE "fiat_provider_accounts" DROP COLUMN IF EXISTS "lastPointBalanceAt";
