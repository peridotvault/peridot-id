-- Chain fee policy v2 tables (ANT-730, spec ANT-727 §4): DB-managed MIN_FEE
-- per chain + relayer subsidy ledger. Additive: safe to apply to any
-- existing database. Existing quotes keep working during rollout — readers
-- fall back to the frozen in-code FEE_POLICY_TABLE when these tables/rows
-- are absent (DB-first, code fallback, same pattern as the chain registry).
-- Down (manual):
--   DROP TABLE IF EXISTS "relayer_subsidy_ledger";
--   DROP TABLE IF EXISTS "chain_min_fees";
--   DROP TABLE IF EXISTS "chain_fee_policies";

CREATE TABLE IF NOT EXISTS "chain_fee_policies" (
  "version" INTEGER NOT NULL,
  "bps" INTEGER NOT NULL DEFAULT 5000,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "fxSource" TEXT NOT NULL DEFAULT 'FALLBACK_STATIC',
  "fxAsOf" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chain_fee_policies_pkey" PRIMARY KEY ("version")
);

CREATE TABLE IF NOT EXISTS "chain_min_fees" (
  "id" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "namespace" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "minFee" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chain_min_fees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chain_min_fees_policyVersion_namespace_reference_key"
  ON "chain_min_fees"("policyVersion", "namespace", "reference");

CREATE INDEX IF NOT EXISTS "chain_min_fees_namespace_reference_idx"
  ON "chain_min_fees"("namespace", "reference");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chain_min_fees_policyVersion_fkey') THEN
    ALTER TABLE "chain_min_fees" ADD CONSTRAINT "chain_min_fees_policyVersion_fkey"
      FOREIGN KEY ("policyVersion") REFERENCES "chain_fee_policies"("version") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "relayer_subsidy_ledger" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "quotedFee" BIGINT NOT NULL,
  "actualCost" BIGINT NOT NULL,
  "subsidy" BIGINT NOT NULL,
  "txHash" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "relayer_subsidy_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "relayer_subsidy_ledger_pid_idx" ON "relayer_subsidy_ledger"("pid");
CREATE INDEX IF NOT EXISTS "relayer_subsidy_ledger_namespace_reference_idx"
  ON "relayer_subsidy_ledger"("namespace", "reference");
CREATE INDEX IF NOT EXISTS "relayer_subsidy_ledger_createdAt_idx" ON "relayer_subsidy_ledger"("createdAt");
