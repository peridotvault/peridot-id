-- DropIndex
DROP INDEX "fiat_ledger_entries_replaySeq_idx";

-- DropIndex
DROP INDEX "fiat_provider_transactions_entryGroup_idx";

-- DropIndex
DROP INDEX "fiat_provider_transactions_replaySeq_idx";

-- AlterTable
ALTER TABLE "fiat_fee_policies" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "lastBalanceAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fiat_provider_transactions" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fiat_webhook_events" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "pid_apps" ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false;
