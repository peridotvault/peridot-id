-- NET-in deposit model: fee = min(net * 5%, Rp25.000), no floor.
-- v1 (floor Rp5.000) is retired; v2 carries minIdr = 0. History rows keep
-- their snapshotted feePolicyVersion, so past quotes are untouched.
-- Fee settlement itself moves to DOKU (NET → user + FEE → Treasury);
-- no fee rows are synthesized by this migration.

ALTER TABLE "fiat_fee_policies" ALTER COLUMN "minIdr" SET DEFAULT 0;

UPDATE "fiat_fee_policies" SET "active" = false WHERE "active" = true;

INSERT INTO "fiat_fee_policies" ("version", "percentBps", "minIdr", "maxIdr", "active")
VALUES (2, 500, 0, 25000, true)
ON CONFLICT ("version") DO UPDATE
SET "percentBps" = 500, "minIdr" = 0, "maxIdr" = 25000, "active" = true;
