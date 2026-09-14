-- chain_accounts: replace (chainNamespace, chainReference) with a single
-- chainId FK. Namespace/reference live once on chains and are read back
-- through the join — never duplicated here.
-- Hand-written: backfill must resolve every row before the new FK lands.

-- 1. Nullable landing column.
ALTER TABLE "chain_accounts" ADD COLUMN "chainId" TEXT;

-- 2. Backfill from the current natural key (every row matches since the
-- compound-FK migration backfilled missing registry rows).
UPDATE "chain_accounts" ca
SET "chainId" = c."id"
FROM "chains" c
WHERE c."namespace" = ca."chainNamespace" AND c."reference" = ca."chainReference";

-- 3. Loud guard: no row may be left without a chain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "chain_accounts" WHERE "chainId" IS NULL) THEN
    RAISE EXCEPTION 'chain_accounts backfill incomplete: rows without a matching chains row remain';
  END IF;
END $$;

-- 4. Constrain + drop the old natural-key columns.
ALTER TABLE "chain_accounts" ALTER COLUMN "chainId" SET NOT NULL;
ALTER TABLE "chain_accounts" ADD CONSTRAINT "chain_accounts_chainId_fkey"
  FOREIGN KEY ("chainId") REFERENCES "chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "chain_accounts_accountId_chainNamespace_chainReference_acco_key";
ALTER TABLE "chain_accounts" DROP CONSTRAINT "chain_accounts_chain_fkey";
ALTER TABLE "chain_accounts" DROP COLUMN "chainNamespace";
ALTER TABLE "chain_accounts" DROP COLUMN "chainReference";
CREATE UNIQUE INDEX "chain_accounts_accountId_chainId_accountType_key"
  ON "chain_accounts"("accountId", "chainId", "accountType");
