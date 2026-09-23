-- Gross/fee/net modeling + minimum-deposit removal.
-- Every money row now carries gross (amountIdr), fee (feeIdr) and net
-- (netIdr = gross − fee once known); the fee policy drops minDepositIdr
-- (no minimum amount — fee = clamp(gross * 5%, 5000, 25000) both ways).

ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "netIdr" BIGINT;

-- Backfill net where the fee is already known.
UPDATE "fiat_provider_transactions"
SET "netIdr" = "amountIdr" - "feeIdr"
WHERE "netIdr" IS NULL AND "feeIdr" IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_transactions_pid_kind_providerStatus_idx') THEN
    CREATE INDEX "fiat_provider_transactions_pid_kind_providerStatus_idx"
      ON "fiat_provider_transactions"("pid", "kind", "providerStatus");
  END IF;
END $$;

ALTER TABLE "fiat_fee_policies" DROP COLUMN IF EXISTS "minDepositIdr";

-- Seed v1 without a minimum (no-op when v1 already exists).
INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "active")
VALUES (1, 500, 5000, 25000, true)
ON CONFLICT ("version") DO NOTHING;
