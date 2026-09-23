-- DOKU Sub-Account V2 migration (1 PID → 1 Sub-Account).
-- Destructive: WaaS rows (provider='doku-waas') have no V2 counterpart
-- (OTP/PIN/binding lifecycle) — all users re-onboard via register.
-- WaaS-only columns (bindingRef, linkId, kycTier) are dropped; V2 mapping
-- columns (profileId, accounts, vaNumber, email, registerRef) are added.
-- New versioned platform fee-policy table, seeded with v1.

DELETE FROM "fiat_webhook_events";
DELETE FROM "fiat_provider_transactions";
DELETE FROM "fiat_provider_accounts";

ALTER TABLE "fiat_provider_accounts" DROP COLUMN IF EXISTS "bindingRef";
ALTER TABLE "fiat_provider_accounts" DROP COLUMN IF EXISTS "linkId";
ALTER TABLE "fiat_provider_accounts" DROP COLUMN IF EXISTS "kycTier";
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "profileId" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "accounts" JSONB;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "vaNumber" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "fiat_provider_accounts" ADD COLUMN IF NOT EXISTS "registerRef" TEXT;
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "provider" SET DEFAULT 'doku-sub-account';
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "accountStatus" SET DEFAULT 'creating';

DROP INDEX IF EXISTS "fiat_provider_accounts_bindingRef_key";

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_accounts_profileId_key') THEN
    CREATE UNIQUE INDEX "fiat_provider_accounts_profileId_key" ON "fiat_provider_accounts"("profileId");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_accounts_registerRef_key') THEN
    CREATE UNIQUE INDEX "fiat_provider_accounts_registerRef_key" ON "fiat_provider_accounts"("registerRef");
  END IF;
END $$;

ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "feeIdr" BIGINT;
ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "feePolicyVersion" INTEGER;

ALTER TABLE "fiat_webhook_events" ALTER COLUMN "provider" SET DEFAULT 'doku-sub-account';

CREATE TABLE IF NOT EXISTS "fiat_fee_policies" (
  "version" INTEGER NOT NULL,
  "percentBps" INTEGER NOT NULL DEFAULT 500,
  "minIdr" BIGINT NOT NULL DEFAULT 5000,
  "maxIdr" BIGINT NOT NULL DEFAULT 25000,
  "minDepositIdr" BIGINT NOT NULL DEFAULT 30000,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiat_fee_policies_pkey" PRIMARY KEY ("version")
);

-- Seed v1: 5% clamped to [Rp5.000, Rp25.000], min deposit Rp30.000.
INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "minDepositIdr", "active")
VALUES (1, 500, 5000, 25000, 30000, true)
ON CONFLICT ("version") DO NOTHING;
