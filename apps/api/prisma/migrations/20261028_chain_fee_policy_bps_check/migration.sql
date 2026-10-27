-- Protocol bound on the chain fee-policy percentage leg (ANT-732 LOW).
-- The API already rejects bps outside 1..5000 with a typed 400; this CHECK
-- makes the invariant hold for any writer (backfills, console edits): the
-- on-chain programs reject anything above MAX_PROTOCOL_FEE_BPS, so the DB
-- must never store it. Additive: safe to apply to any existing database
-- (seeded rows carry bps=5000).
-- Down (manual): ALTER TABLE "chain_fee_policies" DROP CONSTRAINT IF EXISTS "chain_fee_policies_bps_range".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chain_fee_policies_bps_range') THEN
    ALTER TABLE "chain_fee_policies" ADD CONSTRAINT "chain_fee_policies_bps_range"
      CHECK ("bps" >= 0 AND "bps" <= 5000);
  END IF;
END
$$;
