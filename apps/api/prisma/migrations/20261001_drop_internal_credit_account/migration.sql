-- Drop the InternalCreditAccount marker table (unneeded): money movements lock
-- the `identities` rows directly (every credit holder IS an identity, enforced
-- by the journal FK). The table never held a row in production (0 rows at drop
-- time); the journal is untouched. See docs/INTERNAL_CREDIT.md.

DROP TABLE IF EXISTS "internal_credit_accounts";
