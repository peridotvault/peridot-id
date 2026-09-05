-- AlterTable: allow unauthenticated (passkey login) challenges to have no account.
ALTER TABLE "credential_challenges" ALTER COLUMN "accountId" DROP NOT NULL;

-- AlterTable: activity metadata for the transaction/history view.
ALTER TABLE "transactions" ADD COLUMN "type" TEXT;
ALTER TABLE "transactions" ADD COLUMN "amount" BIGINT;
ALTER TABLE "transactions" ADD COLUMN "asset" TEXT;
ALTER TABLE "transactions" ADD COLUMN "direction" TEXT;
ALTER TABLE "transactions" ADD COLUMN "counterparty" TEXT;
