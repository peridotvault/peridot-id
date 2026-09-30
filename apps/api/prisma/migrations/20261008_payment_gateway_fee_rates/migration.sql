-- Payment-gateway (DOKU) fee schedule for top-ups, keyed by DOKU payment
-- method. Admin-edited fallback when DOKU exposes no real-time fee. Additive.

CREATE TABLE IF NOT EXISTS "payment_gateway_fee_rates" (
  "id" TEXT NOT NULL,
  "methodKey" TEXT NOT NULL,
  "percentBps" INTEGER NOT NULL DEFAULT 0,
  "flatIdr" BIGINT NOT NULL DEFAULT 0,
  "minIdr" BIGINT NOT NULL DEFAULT 0,
  "maxIdr" BIGINT NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_gateway_fee_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_gateway_fee_rates_methodKey_key"
  ON "payment_gateway_fee_rates"("methodKey");
