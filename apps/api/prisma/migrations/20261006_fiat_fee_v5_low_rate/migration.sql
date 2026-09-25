-- Global PeridotID fee v5: 0.1% (10 bps), min Rp100, no cap — applies to every
-- fiat movement (user↔user, escrow, topup, withdraw). The clamp is applied by
-- calcServiceFee (packages/payments); the DB row pins the active policy.
-- History is safe: each movement snapshots feePolicyVersion.

INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "active", "createdAt")
VALUES (5, 10, 100, 0, false, CURRENT_TIMESTAMP)
ON CONFLICT ("version") DO NOTHING;

UPDATE "fiat_fee_policies" SET "active" = ("version" = 5);
