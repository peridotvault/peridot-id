-- CreateEnum
CREATE TYPE "AuthorityStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('pending', 'approved', 'executed', 'expired', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('prepared', 'submitted', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "peridot_accounts" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "status" "IdentityStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "peridot_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_accounts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chainNamespace" TEXT NOT NULL,
    "chainReference" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "status" "IdentityStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorities" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "credentialId" TEXT,
    "status" "AuthorityStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "authorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_fee_payers" (
    "id" TEXT NOT NULL,
    "chainAccountId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "IdentityStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_fee_payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chainAccountId" TEXT NOT NULL,
    "intentId" TEXT,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "txHash" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'prepared',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "accountId" TEXT,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chain_accounts_accountId_chainNamespace_chainReference_acco_key" ON "chain_accounts"("accountId", "chainNamespace", "chainReference", "accountType");

-- CreateIndex
CREATE INDEX "authorities_accountId_idx" ON "authorities"("accountId");

-- CreateIndex
CREATE INDEX "wallet_fee_payers_chainAccountId_idx" ON "wallet_fee_payers"("chainAccountId");

-- CreateIndex
CREATE INDEX "intents_accountId_idx" ON "intents"("accountId");

-- CreateIndex
CREATE INDEX "transactions_accountId_idx" ON "transactions"("accountId");

-- CreateIndex
CREATE INDEX "transactions_chainAccountId_idx" ON "transactions"("chainAccountId");

-- CreateIndex
CREATE INDEX "security_events_identityId_idx" ON "security_events"("identityId");

-- CreateIndex
CREATE INDEX "security_events_accountId_idx" ON "security_events"("accountId");

-- AddForeignKey
ALTER TABLE "peridot_accounts" ADD CONSTRAINT "peridot_accounts_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_accounts" ADD CONSTRAINT "chain_accounts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorities" ADD CONSTRAINT "authorities_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_fee_payers" ADD CONSTRAINT "wallet_fee_payers_chainAccountId_fkey" FOREIGN KEY ("chainAccountId") REFERENCES "chain_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intents" ADD CONSTRAINT "intents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_chainAccountId_fkey" FOREIGN KEY ("chainAccountId") REFERENCES "chain_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ADR 004 §4: data migration — wallets → chain_accounts (linked_address), then drop wallets.
-- 1. Create a default peridot_accounts row for every identity that holds a wallet (no
--    smart-account backfill — explicit user action only).
INSERT INTO "peridot_accounts" ("id", "identityId", "status", "version", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, w."identityId", 'active', 1, w."createdAt", w."updatedAt"
FROM "wallets" w
WHERE NOT EXISTS (
    SELECT 1 FROM "peridot_accounts" pa WHERE pa."identityId" = w."identityId"
);

-- 2. Copy each wallet as a linked_address chain account on the default account. The legacy
--    V3 record is user-supplied and not a smart account; ADR 004 keeps it as
--    `linked_address` under the mainnet-beta Solana reference (the only network V3 stored).
INSERT INTO "chain_accounts" ("id", "accountId", "chainNamespace", "chainReference", "address", "accountType", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, pa."id", 'solana', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', w."address", 'linked_address', w."status", w."createdAt", w."updatedAt"
FROM "wallets" w
JOIN "peridot_accounts" pa ON pa."identityId" = w."identityId";

-- 3. Verify the copy before dropping anything (data-preserving migration).
DO $$
DECLARE n_wallets bigint; n_copied bigint;
BEGIN
    SELECT count(*) INTO n_wallets FROM "wallets";
    SELECT count(*) INTO n_copied FROM "chain_accounts" WHERE "accountType" = 'linked_address';
    IF n_copied < n_wallets THEN
        RAISE EXCEPTION 'wallet copy incomplete: % wallets, % chain_accounts copied', n_wallets, n_copied;
    END IF;
END $$;

-- 4. Drop the superseded wallets table (ADR 004 §4).
DROP TABLE "wallets";
