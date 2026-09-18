-- Fiat-only IDR ledger (DOKU Checkout). No on-chain conversion yet.
CREATE TYPE "FiatTopupStatus" AS ENUM ('pending', 'paid', 'expired', 'failed');
CREATE TYPE "FiatWithdrawStatus" AS ENUM ('pending', 'settled', 'rejected');

CREATE TABLE "fiat_topups" (
    "id" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "amountIdr" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "status" "FiatTopupStatus" NOT NULL DEFAULT 'pending',
    "paymentUrl" TEXT,
    "dokuResponse" JSONB,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_topups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fiat_withdraws" (
    "id" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "amountIdr" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "destination" JSONB,
    "status" "FiatWithdrawStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_withdraws_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fiat_topups_invoiceNumber_key" ON "fiat_topups"("invoiceNumber");
CREATE INDEX "fiat_topups_pid_idx" ON "fiat_topups"("pid");
CREATE INDEX "fiat_withdraws_pid_idx" ON "fiat_withdraws"("pid");

ALTER TABLE "fiat_topups" ADD CONSTRAINT "fiat_topups_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fiat_withdraws" ADD CONSTRAINT "fiat_withdraws_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
