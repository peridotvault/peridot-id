-- Relayer USD price-rate table (ANT-602 follow-up to ANT-590 OQ-3 condition 3).
--
-- APPLY ONCE per database (operator, not the cron check — the check scripts
-- are strictly SELECT-only and never create schema):
--   psql "$DATABASE_URL" -f deploy/alerts/relayer-price-rates-ddl.sql
--
-- CONTRACT (mirrors docs/RELAYER_DASHBOARDS.md §4):
--   - One row per chain (chain ∈ solana|stellar|ethereum|base|bsc; see FeeChain).
--   - usd_per_native = USD per ONE whole native coin (e.g. 200.00 = $200/SOL).
--     Never per base unit — the Q8 query divides by the chain's decimals.
--   - asof = when the quoted price was observed (TIMESTAMPTZ, UTC contract
--     ANT-317), set by the refresh job, never by hand.
--   - source = feed name for triage (e.g. 'coingecko', 'coinbase'); free text.
--   - updated_at = row-write time (distinct from asof: a refresh that re-posts
--     an unchanged price still bumps updated_at; staleness is judged on asof).
--   - Refresh cadence: every 5 min (same cron tick as the alert checks).
--     The refresh job holds the price API key via env (PRICE_API_KEY) —
--     never baked into this file, the repo, or dashboards.
--   - Staleness bound: PRICE_STALE_AFTER_SEC (default 900 = 15 min, i.e. three
--     missed refreshes). Older than that → the USD check PAGES on staleness
--     and SKIPS the USD burn evaluation for that chain (fail-closed: never
--     silently value losses at old rates). See relayer-usd-check.sh.
--
-- ROLLBACK: DROP TABLE relayer_price_rates; the native-unit H1 checks keep
-- working (the USD check pages "no rate row" until its cron line is removed).

CREATE TABLE IF NOT EXISTS relayer_price_rates (
  chain TEXT PRIMARY KEY,
  usd_per_native NUMERIC NOT NULL CHECK (usd_per_native > 0),
  asof TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE relayer_price_rates IS
  'ANT-602: per-chain USD price feed for relayer absorbed-loss monitoring. Refresh every 5 min; staleness fails closed (see relayer-usd-check.sh).';
