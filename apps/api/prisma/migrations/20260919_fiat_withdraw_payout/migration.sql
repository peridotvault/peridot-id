-- Kirim DOKU auto-disbursement: verified bank fields + processing/failed states.
ALTER TYPE "FiatWithdrawStatus" ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE "FiatWithdrawStatus" ADD VALUE IF NOT EXISTS 'failed';

ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "bankCode" TEXT;
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "accountNumber" TEXT;
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT;
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'doku';
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "providerRef" TEXT;
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
ALTER TABLE "fiat_withdraws" ADD COLUMN IF NOT EXISTS "providerResponse" JSONB;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_withdraws_providerRef_key') THEN
    CREATE UNIQUE INDEX "fiat_withdraws_providerRef_key" ON "fiat_withdraws"("providerRef");
  END IF;
END $$;
