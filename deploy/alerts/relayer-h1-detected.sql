-- Relayer H1 alert queries (ANT-582, normative basis ANT-575 spec rev 3 §3 FR-H + §7 R-NFR-5/6/9).
--
-- READ-ONLY: SELECT only. Safe to run against the deployed DB on a schedule.
-- Run via deploy/alerts/relayer-h1-check.sh (cron every 5 min).
-- Secrets/thresholds are injected at runtime via env — never baked in here.
--
-- EVENT CONTRACT (canonical names; backend emits per ANT-581):
--   credential.rotated | credential.revoked            { chain }
--   intent.rejected                                     { chain, entryPoint, cause, nonce }
--     cause ∈ stale-nonce | expired | drift | policy-unknown | insufficient-funds | unauthorized
--     entryPoint ∈ withdraw | execute | rotate | activate
--   reconcile.formula_mismatch | reconcile.over_attested { chain, entryPoint, signature, attested, actual, expected, absorbed }
--   relayer.pnl                                         { chain, entryPoint, signature, absorbed, attested, actual }
--   quote.drift_rejected                                { chain, entryPoint, quoted, attested }
--   credential.rotation.unconfirmed (existing) | rotation.confirmed { chain, signature, latencyMs }
--   relay.resolve_landed | relay.resolve_not_landed_rebroadcast | relay.parked_unreadable
--                                                       { chain, entryPoint, nonce, signature }
--   relayer.breaker.opened | relayer.breaker.closed     { chain, absorbedSum, cap, window, reason }
--   chain ∈ solana | stellar | ethereum | base | bsc (FeeChain; missing → 'unknown')
--
-- BACKWARD COMPAT: legacy rows predate chain/entryPoint keys and some canonical
-- names. Every query below counts BOTH canonical and legacy shapes:
--   - revocations: credential.rotated (legacy has no chain → 'unknown' bucket;
--     still counts toward the GLOBAL threshold so spikes are never missed)
--   - divergences: legacy {withdraw,execute}.reconciled with overAttested=true
--     OR protocolFee IS DISTINCT FROM protocolFeeExpected
--   - absorbed loss: legacy relayerAbsorbed on *.reconciled + canonical absorbed
--   - rotation stuck: legacy credential.rotation.unconfirmed
--
-- THRESHOLDS (initials; env-overridable in the check script; OQ-3 caps owned
-- by Trevor+CTO, tuned per deploy/relayer-breaker/README.md):
--   Q1 REVOCATION SPIKE (R-NFR-5): per chain, recent_10m > 5 × trailing
--      baseline AND recent_10m >= 5 (absolute floor: quiet chains must not page
--      on 1-vs-0 flaps; floor fails toward quiet, the GLOBAL count catches
--      cross-chain waves). Fires → PAGE.
--   Q2 INTENT REJECTIONS: per (chain, entryPoint, cause) bucket ≥ 10/15min →
--      NOTIFY; ≥ 50/15min → PAGE (sustained rejection storm = client outage or
--      abuse wave).
--   Q3 DIVERGENCE (R-NFR-6): ANY formula_mismatch/over_attested in 5 min →
--      PAGE (includes legacy-shape rows). Cron runs every 5 min so worst-case
--      detection latency ≈ 5 min + runtime, inside the ≤ 5 min bound.
--   Q4 ABSORBED LOSS (R-NFR-9): rolling-1h absorbed sum per chain ≥ 80% of cap
--      → NOTIFY (approach); ≥ 100% → PAGE (breaker must have opened; if no
--      relayer.breaker.opened row exists for the chain in the window, the
--      page notes a MECHANISM GAP).
--   Q5 ROTATION STUCK: ≥ 3 unconfirmed/15min per chain → NOTIFY (user-visible
--      rotation stall; ≥ 10 → PAGE).
--   Q6 PARKED-UNREADABLE: ANY in 15 min → PAGE (resolve-then-act gave up;
--      operator MUST review per runbook §6 — never auto-clears).
--   Q7 DRIFT SPIKE: per (chain, entryPoint) ≥ 20/15min → NOTIFY (quote/oracle
--      malfunction leading indicator); ≥ 100/15min → PAGE.

-- Q1: revocation spike inputs per chain (shell applies the 5× + floor rule).
-- Returns one row per chain with a revocation in the trailing hour.
SELECT
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COUNT(*) FILTER (WHERE se."createdAt" > now() - interval '10 minutes') AS recent_10m,
  COUNT(*) FILTER (WHERE se."createdAt" <= now() - interval '10 minutes') AS prior_50m
FROM security_events se
WHERE se."eventType" IN ('credential.rotated', 'credential.revoked')
  AND se."createdAt" > now() - interval '1 hour'
GROUP BY 1;

-- Q2: intent rejections by (chain, entryPoint, cause), last 15 min.
SELECT
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COALESCE(se.metadata ->> 'entryPoint', 'unknown') AS entry_point,
  COALESCE(se.metadata ->> 'cause', 'unknown') AS cause,
  COUNT(*) AS rejections
FROM security_events se
WHERE se."eventType" = 'intent.rejected'
  AND se."createdAt" > now() - interval '15 minutes'
GROUP BY 1, 2, 3;

-- Q3: reconciliation divergences, last 5 min (canonical + legacy shapes).
SELECT se."eventType" AS event_type,
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COALESCE(se.metadata ->> 'entryPoint', 'unknown') AS entry_point,
  COUNT(*) AS events
FROM security_events se
WHERE se."createdAt" > now() - interval '5 minutes'
  AND (
    se."eventType" IN ('reconcile.formula_mismatch', 'reconcile.over_attested')
    OR (
      se."eventType" LIKE '%.reconciled'
      AND (
        COALESCE((se.metadata ->> 'overAttested')::boolean, false)
        OR (se.metadata ->> 'protocolFee') IS DISTINCT FROM (se.metadata ->> 'protocolFeeExpected')
      )
    )
  )
GROUP BY 1, 2, 3;

-- Q4: absorbed-loss rolling 1h sum per chain in native base units (bigint),
-- plus whether the breaker opened for that chain in the window.
SELECT
  s.chain AS chain,
  COALESCE(SUM(s.absorbed), 0)::bigint AS absorbed_1h,
  EXISTS (
    SELECT 1 FROM security_events b
    WHERE b."eventType" = 'relayer.breaker.opened'
      AND COALESCE(b.metadata ->> 'chain', 'unknown') = s.chain
      AND b."createdAt" > now() - interval '1 hour'
  ) AS breaker_opened
FROM (
  SELECT
    COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
    COALESCE(NULLIF(se.metadata ->> 'absorbed', ''), NULLIF(se.metadata ->> 'relayerAbsorbed', ''), '0')::numeric AS absorbed
  FROM security_events se
  WHERE (se."eventType" = 'relayer.pnl' OR se."eventType" LIKE '%.reconciled')
    AND se."createdAt" > now() - interval '1 hour'
) s
GROUP BY 1;

-- Q5: rotation confirmations stuck, last 15 min per chain.
SELECT
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COUNT(*) AS unconfirmed
FROM security_events se
WHERE se."eventType" IN ('credential.rotation.unconfirmed', 'rotation.unconfirmed')
  AND se."createdAt" > now() - interval '15 minutes'
GROUP BY 1;

-- Q6: resolve-then-act park events (never auto-clears), last 15 min.
SELECT COUNT(*) AS parked
FROM security_events se
WHERE se."eventType" = 'relay.parked_unreadable'
  AND se."createdAt" > now() - interval '15 minutes';

-- Q6b: resolve-then-act outcome breakdown for the dashboard, last 1 hour.
SELECT
  se."eventType" AS outcome,
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COUNT(*) AS events
FROM security_events se
WHERE se."eventType" IN ('relay.resolve_landed', 'relay.resolve_not_landed_rebroadcast', 'relay.parked_unreadable')
  AND se."createdAt" > now() - interval '1 hour'
GROUP BY 1, 2;

-- Q7: quote-drift rejections per (chain, entryPoint), last 15 min.
SELECT
  COALESCE(se.metadata ->> 'chain', 'unknown') AS chain,
  COALESCE(se.metadata ->> 'entryPoint', 'unknown') AS entry_point,
  COUNT(*) AS drift_rejections
FROM security_events se
WHERE se."eventType" = 'quote.drift_rejected'
  AND se."createdAt" > now() - interval '15 minutes'
GROUP BY 1, 2;
