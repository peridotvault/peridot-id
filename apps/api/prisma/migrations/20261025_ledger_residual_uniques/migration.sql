-- ANT-254 backend residuals: DB-level uniqueness for ledger keys.
-- Additive only. All three are UNIQUE indexes over nullable columns —
-- Postgres permits multiple NULLs, so rows without the key are unaffected.
--
-- Pre-deploy check on shared DBs (must return zero rows before deploy):
--   SELECT "txHash", COUNT(*) FROM "transactions"
--     WHERE "txHash" IS NOT NULL GROUP BY "txHash" HAVING COUNT(*) > 1;
--   SELECT "ledgerRef", COUNT(*) FROM "fiat_provider_transactions"
--     WHERE "ledgerRef" IS NOT NULL GROUP BY "ledgerRef" HAVING COUNT(*) > 1;
-- (fiat_ledger_events.idempotencyKey is a new column — no backfill needed;
-- pre-ANT-254 rows keep NULL and stay exempt.)
-- Verified 2026-10-21 on dev DB: both checks empty (tables empty there).

-- Transaction.txHash: one chain signature = one row. The recordTransaction
-- replay check stays as the UX-friendly 400; this is the race-proof backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_txHash_key"
  ON "transactions"("txHash");

-- FiatProviderTransaction.ledgerRef: one ledger movement = one row.
CREATE UNIQUE INDEX IF NOT EXISTS "fiat_provider_transactions_ledgerRef_key"
  ON "fiat_provider_transactions"("ledgerRef");

-- FiatLedgerEvent.idempotencyKey: outbox dedup (`<entryGroup>:<targetPid>`).
ALTER TABLE "fiat_ledger_events" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "fiat_ledger_events_idempotencyKey_key"
  ON "fiat_ledger_events"("idempotencyKey");
