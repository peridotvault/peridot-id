-- Total MAU vs qualifying Web3 MAU (owner decision 2026-11-18): one row per
-- app/PID/month, `web3` marks the subset that proved an external wallet. The
-- free allowance applies to the web3 subset only; Web2 logins stay unlimited.
ALTER TABLE "usage_monthly" ADD COLUMN "web3" BOOLEAN NOT NULL DEFAULT false;
-- Existing rows were all written by wallet logins.
UPDATE "usage_monthly" SET "web3" = true WHERE "web3" = false;
CREATE INDEX "usage_monthly_appClientId_month_web3_idx" ON "usage_monthly"("appClientId", "month", "web3");
