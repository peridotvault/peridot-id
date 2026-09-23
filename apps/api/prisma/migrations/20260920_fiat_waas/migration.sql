-- DOKU Embedded Wallet (WaaS) mapping tables. DOKU is the authoritative
-- ledger; these tables hold identity mapping, lifecycle state, idempotency
-- keys and cached reads only. Legacy fiat_topups/fiat_withdraws untouched
-- (read-only during settlement, dropped in a later release).

CREATE TABLE IF NOT EXISTS "fiat_provider_accounts" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'doku-waas',
  "providerAccountId" TEXT,
  "linkId" TEXT,
  "accountStatus" TEXT NOT NULL DEFAULT 'provisioning',
  "kycTier" TEXT NOT NULL DEFAULT 'unknown',
  "currency" TEXT NOT NULL DEFAULT 'IDR',
  "lastBalance" TEXT,
  "lastBalanceAt" TIMESTAMPTZ,
  "bindingRef" TEXT,
  "providerResponse" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "fiat_provider_accounts_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_accounts_bindingRef_key') THEN
    CREATE UNIQUE INDEX "fiat_provider_accounts_bindingRef_key" ON "fiat_provider_accounts"("bindingRef");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_accounts_pid_provider_key') THEN
    CREATE UNIQUE INDEX "fiat_provider_accounts_pid_provider_key" ON "fiat_provider_accounts"("pid", "provider");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_accounts_providerAccountId_idx') THEN
    CREATE INDEX "fiat_provider_accounts_providerAccountId_idx" ON "fiat_provider_accounts"("providerAccountId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fiat_provider_accounts_pid_fkey') THEN
    ALTER TABLE "fiat_provider_accounts" ADD CONSTRAINT "fiat_provider_accounts_pid_fkey"
      FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "fiat_provider_transactions" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "accountId" TEXT,
  "kind" TEXT NOT NULL,
  "providerRef" TEXT NOT NULL,
  "providerStatus" TEXT NOT NULL DEFAULT 'created',
  "amountIdr" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'IDR',
  "counterparty" JSONB,
  "providerResponse" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "fiat_provider_transactions_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_transactions_providerRef_key') THEN
    CREATE UNIQUE INDEX "fiat_provider_transactions_providerRef_key" ON "fiat_provider_transactions"("providerRef");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_transactions_pid_idx') THEN
    CREATE INDEX "fiat_provider_transactions_pid_idx" ON "fiat_provider_transactions"("pid");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_provider_transactions_accountId_idx') THEN
    CREATE INDEX "fiat_provider_transactions_accountId_idx" ON "fiat_provider_transactions"("accountId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fiat_provider_transactions_pid_fkey') THEN
    ALTER TABLE "fiat_provider_transactions" ADD CONSTRAINT "fiat_provider_transactions_pid_fkey"
      FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "fiat_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'doku-waas',
  "externalId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiat_webhook_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'fiat_webhook_events_externalId_key') THEN
    CREATE UNIQUE INDEX "fiat_webhook_events_externalId_key" ON "fiat_webhook_events"("externalId");
  END IF;
END $$;
