# PeridotID Relayer Dashboards (ANT-582 · H1)

**Normative basis:** ANT-575 spec rev 3 §3 FR-H H1 (signals i–vi, per chain and
per sponsored entry point) + dashboards line (§3: "Dashboards MUST plot H1
(i)–(vi) per chain"). Backend emission under ANT-581; this doc is the
**event contract + query catalog + panel map** both sides build against.

- Alerting twin: `deploy/alerts/relayer-h1-detected.sql` + `relayer-h1-check.sh`
  (same events, threshold-flavored). Runbook: `docs/RELAYER_RUNBOOK.md`.
- Time zone: all timestamps are `TIMESTAMPTZ` (UTC contract, ANT-317).
- No secrets in queries, labels, or dashboards. Chain/entryPoint/cause travel as
  low-cardinality metadata keys (never pids, signatures, or amounts in labels).

## 1. Event contract (canonical `security_events` rows)

Backend (ANT-581) MUST emit these with the exact names + metadata keys. Queries
below also read the **Legacy** shapes so dashboards stay useful before/after
the hooks land.

| # | H1 signal | Canonical event(s) | Required metadata | Legacy shape (still counted) |
|---|---|---|---|---|
| (i) | Revocation counts + spike rate | `credential.revoked`; alias `credential.rotated` (existing) | `chain` | `credential.rotated` without `chain` → `unknown` bucket |
| (ii) | Intent rejections by typed cause | `intent.rejected` | `chain`, `entryPoint` ∈ `withdraw\|execute\|rotate\|activate`, `cause` ∈ `stale-nonce\|expired\|drift\|policy-unknown\|insufficient-funds\|unauthorized`, `nonce` | none (new signal) |
| (iii) | Reconciliation divergence | `reconcile.formula_mismatch`, `reconcile.over_attested` | `chain`, `entryPoint`, `signature`, `attested`, `actual`, `expected`, `absorbed` (base units, string) | `{withdraw,execute}.reconciled` with `overAttested=true` or `protocolFee≠protocolFeeExpected`; `relayerAbsorbed` as absorbed |
| (iv) | Relayer P&L per tx | `relayer.pnl` | `chain`, `entryPoint`, `signature`, `absorbed`, `attested`, `actual` | `relayerAbsorbed` on `*.reconciled` |
| (v) | Quote-drift rejections + re-quote rate | `quote.drift_rejected` | `chain`, `entryPoint`, `quoted`, `attested` | none (new signal) |
| (vi) | Rotation confirm latency + unconfirmed | `rotation.confirmed` (`latencyMs`, `chain`); `credential.rotation.unconfirmed` (existing, add `chain`) | `chain`, `signature` (+`latencyMs` on confirmed) | `credential.rotation.unconfirmed` without `chain` |
| H2 | Resolve-then-act outcomes | `relay.resolve_landed`, `relay.resolve_not_landed_rebroadcast`, `relay.parked_unreadable` | `chain`, `entryPoint`, `nonce`, `signature?` | none (new signal) |
| H3 | Breaker open/close | `relayer.breaker.opened`, `relayer.breaker.closed` | `chain`, `absorbedSum`, `cap`, `window`; `reason` always; `operator`+`evidence` on close | none (new signal) |

`chain` ∈ `solana|stellar|ethereum|base|bsc` (FeeChain, `solana-relay.ts`), else
`unknown`. All money fields are **strings in native base units** (lamports /
stroops / wei) — never floats.

## 2. Panels (Grafana `deploy/dashboards/relayer-h1.json` mirrors this table)

| Panel | H1 | Query (Postgres; Grafana uses `$__timeFilter("createdAt")` in place of the window) | Type / alert |
|---|---|---|---|
| P1 Revocations/min per chain | (i) | `SELECT date_trunc('minute',"createdAt") t, COALESCE(metadata->>'chain','unknown') c, COUNT(*) FROM security_events WHERE "eventType" IN ('credential.rotated','credential.revoked') AND "createdAt" > now()-interval'6h' GROUP BY 1,2 ORDER BY 1;` | time series; spike overlay from A1 |
| P2 Rejections by cause (stacked) | (ii) | `SELECT COALESCE(metadata->>'cause','unknown') cause, COUNT(*) FROM security_events WHERE "eventType"='intent.rejected' AND "createdAt" > now()-interval'24h' GROUP BY 1;` (+ per-chain split variant in dashboard JSON) | bar/stacked; A2 |
| P3 Divergence feed | (iii) | Runbook §1/A3 example query (row-level, latest 50) | table, red on `formula_mismatch`; A3 |
| P4 Relayer P&L (absorbed/min per chain vs cap line) | (iv) | `SELECT date_trunc('minute',"createdAt") t, COALESCE(metadata->>'chain','unknown') c, SUM(COALESCE(NULLIF(metadata->>'absorbed',''),NULLIF(metadata->>'relayerAbsorbed',''),'0')::numeric) FROM security_events WHERE ("eventType"='relayer.pnl' OR "eventType" LIKE '%.reconciled') AND "createdAt" > now()-interval'6h' GROUP BY 1,2;` + constant cap lines from `deploy/relayer-breaker/breaker.config.example.json` | time series + thresholds; A4 |
| P5 Drift / re-quote rate | (v) | `SELECT date_trunc('minute',"createdAt") t, COALESCE(metadata->>'chain','unknown')||'/'||COALESCE(metadata->>'entryPoint','unknown') c, COUNT(*) FROM security_events WHERE "eventType"='quote.drift_rejected' AND "createdAt" > now()-interval'6h' GROUP BY 1,2;` | time series; A7 |
| P6 Rotation latency p50/p95 + unconfirmed count | (vi) | `SELECT COALESCE(metadata->>'chain','unknown') c, percentile_cont(0.5) WITHIN GROUP (ORDER BY (metadata->>'latencyMs')::numeric) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'latencyMs')::numeric) p95, COUNT(*) n FROM security_events WHERE "eventType"='rotation.confirmed' AND "createdAt" > now()-interval'24h' GROUP BY 1;` + unconfirmed series (A5 query) | stat + series; A5 |
| P7 Resolve-then-act outcomes | H2 | Q6b in `relayer-h1-detected.sql` (counts by outcome × chain, 1h/24h toggles) | pie/stacked; A6 pages on any parked slice |
| P8 Breaker state | H3 | Latest `relayer.breaker.opened/closed` per chain: `SELECT DISTINCT ON (COALESCE(metadata->>'chain','unknown')) COALESCE(metadata->>'chain','unknown') c, "eventType", "createdAt", metadata->>'reason' FROM security_events WHERE "eventType" IN ('relayer.breaker.opened','relayer.breaker.closed') ORDER BY 1, "createdAt" DESC;` | state timeline; A4 |
| P9 Relayer P&L in USD (absorbed-USD/min per chain vs USD cap line) | (iv) USD lens | `deploy/dashboards/relayer-h1.json` panel 9 (join `relayer_price_rates`, fresh-only — see §4) + constant USD cap lines from `deploy/relayer-breaker/prices.config.example.json` | time series + thresholds; A8 |

Refresh: P1/P3/P4/P8 every 30 s; rest every 5 min. Dashboard JSON uses a
`postgres` datasource variable + `$chain` / `$entryPoint` filters.

## 3. Freshness / ownership

- Owner: DevOps (Trevor). Backend event emission: Tyler (ANT-581) — any rename
  lands here + in `relayer-h1-detected.sql` + the check script in the SAME PR
  (contract changes are atomic, never half-applied).
- QA (Tristan, ANT-583) validates AC-H against these panels: every H-AC must
  be producible on P1–P8 with a timestamped screenshot/row dump.

## 4. USD-equivalent absorbed loss (ANT-602 · OQ-3 condition 3)

Native-unit P4 answers "how many base units did the relayer absorb"; P9 answers
"how many dollars is that" — the lens the board asked for, and the one that
stays comparable when native prices move. The USD lens is **additive**: native
Q4/A4 keep paging independently, so a dead price feed degrades the dollar view,
never the breaker.

### 4.1 Price-rate contract (`relayer_price_rates`)

- Table: `deploy/alerts/relayer-price-rates-ddl.sql` (applied ONCE per DB by the
  operator — check scripts are SELECT-only and never create schema).
- One row per chain: `usd_per_native` (USD per ONE whole coin, never per base
  unit), `asof` (when the price was observed, TIMESTAMPTZ UTC), `source` (feed
  name), `updated_at` (row-write time).
- Decimals (base units → whole coin): solana ÷1e9, stellar ÷1e7,
  ethereum/base/bsc ÷1e18. `unknown`-chain traffic has no economics row and is
  always treated as stale (fail-closed).
- Refresh: every 5 min by the operator's price job. The price API key travels
  as `PRICE_API_KEY` via runtime env (Infisical `/apps/api`, same path as the
  alert checks) — never baked into the repo, dashboards, or logs. Reference
  secret *names* only.
- USD caps + initial tuning: `deploy/relayer-breaker/prices.config.example.json`
  (derived from the native OQ-3 caps at documented reference rates; re-tuned
  with the native caps, CTO sign-off, audit gate R-NFR-10 before mainnet).

### 4.2 Staleness handling (fail-closed)

- Bound: `PRICE_STALE_AFTER_SEC` (default 900 s = three missed refreshes).
- Alert check (`relayer-usd-check.sh` Q8): per chain WITH 1h traffic, the rate
  row must exist and `now() − asof ≤ PRICE_STALE_AFTER_SEC` before any USD burn
  comparison. Otherwise the script **PAGES "price feed stale" and SKIPS the USD
  evaluation for that chain** — old rates are never silently used, and the
  native-unit Q4 keeps paging underneath.
- Dashboard P9 uses an INNER JOIN + `r.asof > now() − interval '15 minutes'`:
  stale-price chains **drop off the panel instead of plotting old rates**.
  A chain line that vanishes while its P4 (native) line keeps climbing = feed
  outage, not zero loss. The freshness predicate (15 min) is intentionally the
  same order as the alert bound; both are documented here so they cannot drift
  silently — changing one means changing the other in the SAME PR.
- Missing table = config error (check exits 3 with the DDL pointer), never OK.
