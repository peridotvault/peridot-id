-- ANT-866 B1: claiming-key binding for PDA derivation. Expand-only: one
-- nullable column, no changes to existing rows, no data movement. Pre-B1
-- rows keep NULL and heal to the asserting key on next activation. Safe to
-- apply on a live database.
ALTER TABLE "chain_accounts" ADD COLUMN "claimAuthority" BYTEA;
