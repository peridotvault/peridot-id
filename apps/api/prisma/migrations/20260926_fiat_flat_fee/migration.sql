-- Flat 5% platform fee, no floor, no cap: fee = round-half-up(net * 5%).
-- v2 (capped at Rp25.000) is retired; v3 carries minIdr = 0, maxIdr = 0
-- (0/0 = uncapped sentinel — min/max are retained for schema compat but the
-- formula no longer applies them). History rows keep their snapshotted
-- feePolicyVersion, so past quotes are untouched.
-- Settlement itself is DOKU-native per payment (DOKU_SPLIT_RULE_ID static
-- PERCENTAGE rule: Treasury leg + user remainder); no fee rows are
-- synthesized by this migration.

UPDATE "fiat_fee_policies" SET "active" = false WHERE "active" = true;

INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "active")
VALUES (3, 500, 0, 0, true)
ON CONFLICT ("version") DO UPDATE
SET "percentBps" = 500, "minIdr" = 0, "maxIdr" = 0, "active" = true;
