-- Activate the bounded PeridotID service fee: 5% clamped to [Rp5.000, Rp25.000].
-- The clamp is applied by calcServiceFee (packages/payments); the DB row pins
-- the active policy. History is safe: every movement snapshots feePolicyVersion,
-- so older rows keep their own bounds. Idempotent (ON CONFLICT DO NOTHING).
-- See docs/INTERNAL_CREDIT.md and docs/prds/PRD_v6.md §3.

INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "active", "createdAt")
VALUES (4, 500, 5000, 25000, false, CURRENT_TIMESTAMP)
ON CONFLICT ("version") DO NOTHING;

UPDATE "fiat_fee_policies" SET "active" = ("version" = 4);
