-- Relayer USD-equivalent absorbed-loss alert queries (ANT-602, follow-up to
-- ANT-590 OQ-3 condition 3; normative basis ANT-575 R-NFR-9 + audit gate R-NFR-10).
--
-- READ-ONLY: SELECT only. Safe to run against the deployed DB on a schedule.
-- Run via deploy/alerts/relayer-usd-check.sh (cron every 5 min, same tick as
-- relayer-h1-check.sh). Native-unit Q4 in relayer-h1-detected.sql is unchanged
-- and keeps paging independently — USD is a second lens, never a replacement.
--
-- PRICE SOURCE: relayer_price_rates (see relayer-price-rates-ddl.sql), refreshed
-- every 5 min by the operator's price job (API key via env PRICE_API_KEY, never
-- in repo). Decimals: solana 1e9 (lamports), stellar 1e7 (stroops),
-- ethereum/base/bsc 1e18 (wei); unknown chains use 1e18 AND are always treated
-- as stale (fail-closed: unknown economics must page, never silently pass).
--
-- STALENESS RULE (fail-closed): a chain's USD evaluation is valid ONLY when a
-- rate row exists AND asof is within PRICE_STALE_AFTER_SEC (default 900 s).
-- Otherwise the shell PAGES "price feed stale" for that chain and SKIPS the USD
-- burn comparison — old rates are never silently used. Absence of the table
-- itself is a config error (exit 3), not an OK.
--
-- THRESHOLDS (initials; env-overridable in the check script; USD caps owned by
-- Trevor+CTO alongside the native OQ-3 caps, tuned per
-- deploy/relayer-breaker/prices.config.example.json):
--   Q8 USD BURN (R-NFR-9, USD lens): rolling-1h absorbed USD sum per chain
--      ≥ 80% of USD cap → NOTIFY; ≥ 100% → PAGE (same mechanism-gap note as Q4:
--      a USD page without a relayer.breaker.opened row for the chain in the
--      window notes a MECHANISM GAP).
--   Q9 STALENESS: any chain with sponsored pnl/reconciled rows in the last 1h
--      but no fresh rate row → PAGE (fail-closed). Chains with no traffic in
--      the window are reported as NOTIFY, not PAGE (no loss to misprice).

-- Q8: USD absorbed-loss rolling 1h sum per chain, with rate age for the
-- staleness gate. One row per chain that has pnl/reconciled traffic in 1h.
-- usd_1h is NULL when no rate row exists (shell treats as stale).
SELECT
  s.chain AS chain,
  COALESCE(SUM(s.absorbed_native * r.usd_per_native), NULL) AS usd_1h,
  COALESCE(MAX(EXTRACT(EPOCH FROM (now() - r.asof)))::bigint, NULL) AS rate_age_sec,
  (r.chain IS NULL) AS no_rate_row,
  EXISTS (
    SELECT 1 FROM security_events b
    WHERE b."eventType" = 'relayer.breaker.opened'
      AND COALESCE(b.metadata ->> 'chain', 'unknown') = s.chain
      AND b."createdAt" > now() - interval '1 hour'
  ) AS breaker_opened
FROM (
  SELECT
    COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
    COALESCE(NULLIF(se.metadata ->> 'absorbed', ''), NULLIF(se.metadata ->> 'relayerAbsorbed', ''), '0')::numeric
      / CASE COALESCE(se.metadata ->> 'chain', 'unknown')
          WHEN 'solana' THEN 1000000000
          WHEN 'stellar' THEN 10000000
          ELSE 1000000000000000000
        END AS absorbed_native
  FROM security_events se
  WHERE (se."eventType" = 'relayer.pnl' OR se."eventType" LIKE '%.reconciled')
    AND se."createdAt" > now() - interval '1 hour'
) s
LEFT JOIN relayer_price_rates r ON r.chain = s.chain
GROUP BY 1, r.chain, r.usd_per_native;

-- Q9: feed staleness audit — every rate row with its age (shell applies the
-- PRICE_STALE_AFTER_SEC bound; unknown chains never have rows → always stale).
SELECT
  r.chain AS chain,
  EXTRACT(EPOCH FROM (now() - r.asof))::bigint AS age_sec,
  r.source AS source
FROM relayer_price_rates r;
