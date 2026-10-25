#!/usr/bin/env bash
# ANT-602: cron-friendly check for relayer USD-equivalent absorbed loss
# (ANT-590 OQ-3 condition 3; USD lens on R-NFR-9. Native-unit Q4 in
# relayer-h1-check.sh is unchanged and keeps paging independently).
# READ-ONLY against the DB (SELECT only). No app, schema, or data changes.
#
# Usage:
#   DATABASE_URL=postgresql://... ./relayer-usd-check.sh
#   DATABASE_URL=postgresql://... ALERT_WEBHOOK_URL=https://... ALERT_PAGE_URL=https://... ./relayer-usd-check.sh
#
# Exit codes (Nagios/cron convention, same as relayer-h1-check.sh):
#   0 = OK (rates fresh, USD burn under thresholds)
#   2 = ALERT (any PAGE or NOTIFY — stdout lines prefixed PAGE:/NOTIFY:)
#   3 = usage/config error (DATABASE_URL unset, psql missing/failing, or the
#       relayer_price_rates table missing — apply relayer-price-rates-ddl.sql)
#
# Cron (every 5 min, same tick as the H1 check):
#   */5 * * * *  DATABASE_URL='postgresql://...' ALERT_PAGE_URL='...' ALERT_WEBHOOK_URL='...' /opt/peridot-id/deploy/alerts/relayer-usd-check.sh
# Installed automatically via deploy/alerts/install.sh (tagged #peridot-alert).
#
# STALENESS RULE (fail-closed): a chain's USD burn is evaluated ONLY when its
# rate row exists and is fresher than PRICE_STALE_AFTER_SEC (default 900 s =
# 15 min, i.e. three missed 5-min refreshes). Otherwise the script PAGES
# "price feed stale" for that chain and SKIPS the USD comparison — old rates
# are never silently used. Chains with traffic but no rate row page the same
# way; 'unknown'-chain traffic always pages stale (unknown economics must
# never silently pass).
#
# Secrets / tuning are injected at runtime via env — never baked into this file:
#   DATABASE_URL (required)            Postgres target (read-only session).
#   ALERT_WEBHOOK_URL (optional)       NOTIFY route. POSTs {"text": ...}.
#   ALERT_PAGE_URL (optional)          PAGE route. Falls back to ALERT_WEBHOOK_URL.
#   PRICE_STALE_AFTER_SEC (default 900)  max rate age before fail-closed page.
#   Per-chain USD caps, rolling-1h absorbed USD (defaults = initial tuning,
#   see deploy/relayer-breaker/prices.config.example.json):
#   USD_CAP_SOLANA (default 0.20)      USD / 1h  (= 0.001 SOL @ $200)
#   USD_CAP_STELLAR (default 0.03)     USD / 1h  (= 0.1 XLM @ $0.30)
#   USD_CAP_ETHEREUM (default 60.00)   USD / 1h  (= 0.02 ETH @ $3000)
#   USD_CAP_BASE (default 1.50)        USD / 1h  (= 0.0005 ETH @ $3000)
#   USD_CAP_BSC (default 1.20)         USD / 1h  (= 0.002 BNB @ $600)
#   Unknown-chain traffic never evaluates USD (always stale → page).
#
# Rollback: remove the cron line (or delete these files). Nothing was written to
# the DB, so there is nothing to undo there. Native-unit alerting is untouched.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "CRITICAL: DATABASE_URL is not set (refusing to guess a target)" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "CRITICAL: psql not found in PATH" >&2
  exit 3
fi
if ! command -v awk >/dev/null 2>&1; then
  echo "CRITICAL: awk not found in PATH (needed for USD decimal comparison)" >&2
  exit 3
fi

STALE_AFTER="${PRICE_STALE_AFTER_SEC:-900}"
USD_SOLANA="${USD_CAP_SOLANA:-0.20}"
USD_STELLAR="${USD_CAP_STELLAR:-0.03}"
USD_ETHEREUM="${USD_CAP_ETHEREUM:-60.00}"
USD_BASE="${USD_CAP_BASE:-1.50}"
USD_BSC="${USD_CAP_BSC:-1.20}"

# Q8 columns: chain | usd_1h (may be empty when no rate row) | rate_age_sec
# (may be empty) | no_rate_row (t/f) | breaker_opened (t/f).
Q8="SELECT s.chain, COALESCE(SUM(s.absorbed_native * r.usd_per_native), NULL), COALESCE(MAX(EXTRACT(EPOCH FROM (now() - r.asof)))::bigint, NULL), (r.chain IS NULL), EXISTS (SELECT 1 FROM security_events b WHERE b.\"eventType\" = 'relayer.breaker.opened' AND COALESCE(b.metadata ->> 'chain', 'unknown') = s.chain AND b.\"createdAt\" > now() - interval '1 hour') FROM (SELECT COALESCE(se.metadata ->> 'chain', 'unknown') AS chain, COALESCE(NULLIF(se.metadata ->> 'absorbed', ''), NULLIF(se.metadata ->> 'relayerAbsorbed', ''), '0')::numeric / CASE COALESCE(se.metadata ->> 'chain', 'unknown') WHEN 'solana' THEN 1000000000 WHEN 'stellar' THEN 10000000 ELSE 1000000000000000000 END AS absorbed_native FROM security_events se WHERE (se.\"eventType\" = 'relayer.pnl' OR se.\"eventType\" LIKE '%.reconciled') AND se.\"createdAt\" > now() - interval '1 hour') s LEFT JOIN relayer_price_rates r ON r.chain = s.chain GROUP BY 1, r.chain, r.usd_per_native;"

run_q() {
  local out
  if ! out="$(psql "$DATABASE_URL" -X -q -t -A -F' ' -c "$1" 2>&1)"; then
    if printf '%s' "$out" | grep -qi 'relayer_price_rates.*does not exist'; then
      echo "CRITICAL: relayer_price_rates table missing — apply deploy/alerts/relayer-price-rates-ddl.sql once, then re-enable this check" >&2
    else
      echo "CRITICAL: query failed: $out" >&2
    fi
    exit 3
  fi
  printf '%s' "$out"
}

cap_for() {
  case "$1" in
    solana) echo "$USD_SOLANA" ;; stellar) echo "$USD_STELLAR" ;;
    ethereum) echo "$USD_ETHEREUM" ;; base) echo "$USD_BASE" ;;
    bsc) echo "$USD_BSC" ;; *) echo "" ;;
  esac
}

# ge80: true iff value >= 80% of cap (decimal-safe via awk).
ge80() { awk -v v="$1" -v c="$2" 'BEGIN{exit !(v + 0 >= c * 0.8)}'; }
ge100() { awk -v v="$1" -v c="$2" 'BEGIN{exit !(v + 0 >= c + 0)}'; }

PAGES=(); NOTIFIES=()

# Q8: per chain with 1h traffic — staleness gate FIRST, USD burn second.
# NOTE: the query output is captured BEFORE the loop (not via <<< "$(...)")
# so a failing query propagates exit 3 instead of silently yielding OK.
Q8_OUT="$(run_q "$Q8")" || exit 3
while IFS=' ' read -r chain usd age norate opened; do
  [[ -z "$chain" ]] && continue
  cap="$(cap_for "$chain")"
  # Fail-closed: unknown chain, missing row, missing/old age → page stale,
  # never evaluate USD.
  if [[ -z "$cap" || "$norate" == "t" || -z "$age" || ! "$age" =~ ^[0-9]+$ ]]; then
    PAGES+=("relayer USD price feed stale: chain=$chain has 1h traffic but no usable rate (fail-closed, R-NFR-9 USD lens blind — refresh the feed, native-unit Q4 still paging)")
    continue
  fi
  if (( age > STALE_AFTER )); then
    PAGES+=("relayer USD price feed stale: chain=$chain rate age ${age}s > ${STALE_AFTER}s (fail-closed: USD burn skipped, native-unit Q4 still paging)")
    continue
  fi
  if [[ -z "$usd" ]]; then
    PAGES+=("relayer USD price feed stale: chain=$chain rate fresh but USD sum unavailable (fail-closed — investigate feed decimals)")
    continue
  fi
  if ge100 "$usd" "$cap"; then
    gap=""; [[ "$opened" != "t" ]] && gap=" MECHANISM GAP: no relayer.breaker.opened for $chain in window"
    PAGES+=("absorbed loss USD $chain: \$$usd >= cap \$$cap/1h$gap")
  elif ge80 "$usd" "$cap"; then
    NOTIFIES+=("absorbed loss USD $chain approaching cap: \$$usd / \$$cap/1h (80%)")
  fi
done <<< "$Q8_OUT"

if (( ${#PAGES[@]} == 0 && ${#NOTIFIES[@]} == 0 )); then
  echo "OK: relayer USD burn within thresholds and price feed fresh (stale-after=${STALE_AFTER}s)"
  exit 0
fi

if (( ${#PAGES[@]} > 0 )); then for p in "${PAGES[@]}"; do echo "PAGE: $p"; done; fi
if (( ${#NOTIFIES[@]} > 0 )); then for n in "${NOTIFIES[@]}"; do echo "NOTIFY: $n"; done; fi

PAGE_URL="${ALERT_PAGE_URL:-${ALERT_WEBHOOK_URL:-}}"
NOTIFY_URL="${ALERT_WEBHOOK_URL:-}"
post() { # $1=url $2=text
  [[ -n "$1" ]] || return 0
  curl -fsS -m 10 -X POST "$1" -H 'Content-Type: application/json' \
    --data "$(printf '{"text": %s}' "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" >/dev/null \
    || echo "WARNING: webhook POST failed (alert still reported via stdout/exit code)" >&2
}
if (( ${#PAGES[@]} > 0 )); then post "$PAGE_URL" "PAGE relayer USD: $(printf '%s; ' "${PAGES[@]}")"; fi
if (( ${#NOTIFIES[@]} > 0 )); then post "$NOTIFY_URL" "NOTIFY relayer USD: $(printf '%s; ' "${NOTIFIES[@]}")"; fi

exit 2
