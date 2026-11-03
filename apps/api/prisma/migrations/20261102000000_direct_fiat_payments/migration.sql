CREATE TABLE "fiat_payments" (
"id" TEXT PRIMARY KEY, "nextCheckAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "appClientId" TEXT NOT NULL, "payerPid" TEXT, "beneficiaryPid" TEXT NOT NULL,
"externalId" TEXT NOT NULL, "description" TEXT, "metadata" JSONB NOT NULL,
"amountIdr" BIGINT NOT NULL CHECK ("amountIdr" > 0), "feeIdr" BIGINT NOT NULL CHECK ("feeIdr" >= 0),
"totalIdr" BIGINT NOT NULL, "quote" JSONB NOT NULL, "providerRef" TEXT NOT NULL UNIQUE,
"paymentUrl" TEXT, "status" TEXT NOT NULL DEFAULT 'created', "expiresAt" TIMESTAMPTZ(3) NOT NULL,
"paidAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"refundedIdr" BIGINT NOT NULL DEFAULT 0 CHECK ("refundedIdr" >= 0 AND "refundedIdr" <= "amountIdr"),
UNIQUE ("appClientId", "externalId")
);
CREATE INDEX "fiat_payments_status_createdAt_idx" ON "fiat_payments" ("status", "createdAt");
