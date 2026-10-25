-- Reconcile migration history with prisma/schema.prisma: the chain accumulated
-- four indexes and two column defaults that the schema never declared (the
-- indexes were hand-created in 20260928_fiat_double_entry / 20260827, the
-- defaults in 20261020/20261031), so `migrate dev` reported permanent drift.
-- Idempotent: some DBs (any that already dropped these by hand) lack them.
DROP INDEX IF EXISTS "fiat_ledger_entries_replaySeq_idx";

-- DropIndex
DROP INDEX IF EXISTS "fiat_provider_transactions_entryGroup_idx";

-- DropIndex
DROP INDEX IF EXISTS "fiat_provider_transactions_replaySeq_idx";

-- DropIndex
DROP INDEX IF EXISTS "wallet_fee_payers_chainAccountId_idx";

-- AlterTable (@updatedAt is applied by Prisma, no DB default)
ALTER TABLE "evm_relayer_keys" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable (@updatedAt is applied by Prisma, no DB default)
ALTER TABLE "system_settings" ALTER COLUMN "updatedAt" DROP DEFAULT;
