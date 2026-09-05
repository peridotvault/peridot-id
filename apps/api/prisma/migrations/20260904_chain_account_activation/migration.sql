-- Create the new ChainAccountStatus enum.
CREATE TYPE "ChainAccountStatus" AS ENUM ('inactivated', 'funded', 'ready', 'activating', 'active', 'insufficient');

-- Recreate the status column using the new enum.
ALTER TABLE "chain_accounts"
  ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "chain_accounts"
  ALTER COLUMN "status" TYPE "ChainAccountStatus"
  USING ("status"::text)::"ChainAccountStatus";
ALTER TABLE "chain_accounts"
  ALTER COLUMN "status" SET DEFAULT 'inactivated';

-- New activation bookkeeping columns.
ALTER TABLE "chain_accounts"
  ADD COLUMN "activationBalance" BIGINT,
  ADD COLUMN "activationRequired" BIGINT;
