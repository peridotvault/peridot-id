-- PPN (VAT) config: PeridotID PPN on the fee-policy versions, plus one
-- singleton DOKU-wide PPN applied to payment-gateway fees. Additive.

ALTER TABLE "fiat_fee_policies"
  ADD COLUMN IF NOT EXISTS "taxBps" INTEGER NOT NULL DEFAULT 1100;

CREATE TABLE IF NOT EXISTS "fiat_tax_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "dokuTaxBps" INTEGER NOT NULL DEFAULT 1100,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fiat_tax_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "fiat_tax_settings" ("id", "dokuTaxBps", "updatedAt")
VALUES (1, 1100, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
