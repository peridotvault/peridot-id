-- ADR-008: remove PidAccount. 1 identity = 1 personal wallet — every
-- wallet-owned row references Identity.pid directly.
-- Hand-written: backfill preserves rows; `migrate dev` would drop/recreate.
-- With 1 pid per account the backfill is lossless (pid_accounts.pid carries
-- the owner; SecurityEvent.accountId is dropped because pid is the scope).

-- 1. Landing columns.
ALTER TABLE "chain_accounts" ADD COLUMN "pid" TEXT;
ALTER TABLE "authorities" ADD COLUMN "pid" TEXT;
ALTER TABLE "intents" ADD COLUMN "pid" TEXT;
ALTER TABLE "transactions" ADD COLUMN "pid" TEXT;
ALTER TABLE "credential_challenges" ADD COLUMN "pid" TEXT;

-- 2. Backfill owners through the old hub.
UPDATE "chain_accounts" ca SET "pid" = pa."pid" FROM "pid_accounts" pa WHERE pa."id" = ca."accountId";
UPDATE "authorities" a SET "pid" = pa."pid" FROM "pid_accounts" pa WHERE pa."id" = a."accountId";
UPDATE "intents" i SET "pid" = pa."pid" FROM "pid_accounts" pa WHERE pa."id" = i."accountId";
UPDATE "transactions" t SET "pid" = pa."pid" FROM "pid_accounts" pa WHERE pa."id" = t."accountId";
UPDATE "credential_challenges" cc SET "pid" = pa."pid" FROM "pid_accounts" pa WHERE pa."id" = cc."accountId";

-- 3. Loud guard: no orphan rows (challenges with NULL accountId stay NULL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "chain_accounts" WHERE "pid" IS NULL) THEN
    RAISE EXCEPTION 'pid backfill incomplete: chain_accounts rows without pid remain';
  END IF;
  IF EXISTS (SELECT 1 FROM "authorities" WHERE "pid" IS NULL) THEN
    RAISE EXCEPTION 'pid backfill incomplete: authorities rows without pid remain';
  END IF;
  IF EXISTS (SELECT 1 FROM "intents" WHERE "pid" IS NULL) THEN
    RAISE EXCEPTION 'pid backfill incomplete: intents rows without pid remain';
  END IF;
  IF EXISTS (SELECT 1 FROM "transactions" WHERE "pid" IS NULL) THEN
    RAISE EXCEPTION 'pid backfill incomplete: transactions rows without pid remain';
  END IF;
END $$;

-- 4. Constrain the new columns.
ALTER TABLE "chain_accounts" ALTER COLUMN "pid" SET NOT NULL;
ALTER TABLE "authorities" ALTER COLUMN "pid" SET NOT NULL;
ALTER TABLE "intents" ALTER COLUMN "pid" SET NOT NULL;
ALTER TABLE "transactions" ALTER COLUMN "pid" SET NOT NULL;

-- 5. Drop the old hub-facing objects.
DROP INDEX "chain_accounts_accountId_chainId_accountType_key";
ALTER TABLE "chain_accounts" DROP CONSTRAINT "chain_accounts_accountId_fkey";
ALTER TABLE "authorities" DROP CONSTRAINT "authorities_accountId_fkey";
DROP INDEX "authorities_accountId_idx";
ALTER TABLE "intents" DROP CONSTRAINT "intents_accountId_fkey";
DROP INDEX "intents_accountId_idx";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_accountId_fkey";
DROP INDEX "transactions_accountId_idx";
ALTER TABLE "credential_challenges" DROP CONSTRAINT "credential_challenges_accountId_fkey";
DROP INDEX "credential_challenges_accountId_idx";
ALTER TABLE "security_events" DROP CONSTRAINT "security_events_accountId_fkey";
DROP INDEX "security_events_accountId_idx";

-- 6. Drop old columns + the hub table.
ALTER TABLE "chain_accounts" DROP COLUMN "accountId";
ALTER TABLE "authorities" DROP COLUMN "accountId";
ALTER TABLE "intents" DROP COLUMN "accountId";
ALTER TABLE "transactions" DROP COLUMN "accountId";
ALTER TABLE "credential_challenges" DROP COLUMN "accountId";
ALTER TABLE "security_events" DROP COLUMN "accountId";
DROP TABLE "pid_accounts";

-- 7. New FKs + uniques + indexes (Prisma-default names).
ALTER TABLE "chain_accounts" ADD CONSTRAINT "chain_accounts_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "authorities" ADD CONSTRAINT "authorities_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "intents" ADD CONSTRAINT "intents_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_challenges" ADD CONSTRAINT "credential_challenges_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "chain_accounts_pid_chainId_accountType_key"
  ON "chain_accounts"("pid", "chainId", "accountType");
CREATE INDEX "authorities_pid_idx" ON "authorities"("pid");
CREATE INDEX "intents_pid_idx" ON "intents"("pid");
CREATE INDEX "transactions_pid_idx" ON "transactions"("pid");
CREATE INDEX "credential_challenges_pid_idx" ON "credential_challenges"("pid");
