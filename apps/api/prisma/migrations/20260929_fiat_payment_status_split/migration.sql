-- Payment/settlement semantic split (correction: settlement must never read as
-- payment-confirmed, and providerStatus must not be overloaded).
--
-- 1. New nullable providerPaymentStatus (pending | success | expired | failed
--    | refunded): payment truth for deposit rows. Backfilled from legacy
--    providerStatus for deposits only (movement legs keep providerStatus as
--    their DOKU-movement state):
--      success/settled -> success (legacy "settled" on deposits meant paid)
--      failed          -> failed
--      refunded        -> refunded
--      cancelled       -> expired ONLY when the row carries the checkoutExpired
--                         marker (Checkout expiry); user-cancelled intents and
--                         anything else stay NULL (terminal via providerStatus,
--                         never payment-confirmed).
-- 2. Remediate the 20260927 backfill, which marked settlementStatus='settled'
--    wherever providerStatus='settled' (payment-confirmation masquerading as
--    settlement). Settlement is re-observed from SETTLEMENT-family history by
--    reconcile, so reset deposit flags to 'pending' — the conservative
--    direction (pending = unknown, settled = assertion). Backfilled CREDIT
--    rows are payment-ish history, not settlement evidence.

ALTER TABLE "fiat_provider_transactions" ADD COLUMN IF NOT EXISTS "providerPaymentStatus" TEXT;

UPDATE "fiat_provider_transactions"
SET "providerPaymentStatus" = 'success'
WHERE "providerPaymentStatus" IS NULL
  AND "kind" = 'deposit'
  AND "providerStatus" IN ('success', 'settled');

UPDATE "fiat_provider_transactions"
SET "providerPaymentStatus" = 'failed'
WHERE "providerPaymentStatus" IS NULL
  AND "kind" = 'deposit'
  AND "providerStatus" = 'failed';

UPDATE "fiat_provider_transactions"
SET "providerPaymentStatus" = 'refunded'
WHERE "providerPaymentStatus" IS NULL
  AND "kind" = 'deposit'
  AND "providerStatus" = 'refunded';

UPDATE "fiat_provider_transactions"
SET "providerPaymentStatus" = 'expired'
WHERE "providerPaymentStatus" IS NULL
  AND "kind" = 'deposit'
  AND "providerStatus" = 'cancelled'
  AND "providerResponse"::text LIKE '%checkoutExpired%';

UPDATE "fiat_provider_transactions"
SET "settlementStatus" = 'pending'
WHERE "kind" = 'deposit'
  AND "settlementStatus" = 'settled';
