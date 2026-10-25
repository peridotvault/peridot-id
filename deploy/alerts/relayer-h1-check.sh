#!/usr/bin/env bash
# ANT-582: cron-friendly check for relayer H1 alert thresholds (ANT-575 FR-H H1, R-NFR-5/6/9).
# READ-ONLY against the DB (SELECT only). No app, schema, or data changes.
#
# Usage:
#   DATABASE_URL=postgresql://... ./relayer-h1-check.sh
#   DATABASE_URL=postgresql://... ALERT_WEBHOOK_URL=https://... ALERT_PAGE_URL=https://... ./relayer-h1-check.sh
#
# Exit codes (Nagios/cron convention):
#   0 = OK (no threshold breached)
#   2 = ALERT (any PAGE threshold breached, or any NOTIFY threshold breached —
#       stdout lines are prefixed PAGE: or NOTIFY: so the router can split them)
#   3 = usage/config error (DATABASE_URL unset, psql missing/failing)
#
# Cron (every 5 min — the interval IS the R-NFR-5/6 latency bound: worst-case
# detection latency ≈ interval + runtime, inside the ≤ 5 min requirement):
#   */5 * * * *  DATABASE_URL='postgresql://...' ALERT_PAGE_URL='...' ALERT_WEBHOOK_URL='...' /opt/peridot-id/deploy/alerts/relayer-h1-check.sh
#
# Secrets / tuning are injected at runtime via env — never baked into this file:
#   DATABASE_URL (required)            Postgres target (read-only session).
#   ALERT_WEBHOOK_URL (optional)       NOTIFY route (chat/channel). POSTs {"text": ...}.
#   ALERT_PAGE_URL (optional)          PAGE route (PagerDuty/Opsgenie). Falls back to ALERT_WEBHOOK_URL.
#   Per-query thresholds (defaults = initial tuning, see deploy/relayer-breaker/README.md):
#   REVOCATION_FLOOR (default 5)                 Q1 absolute floor per chain / 10 min.
#   REJECT_NOTIFY (default 10) REJECT_PAGE (default 50)          Q2 per bucket / 15 min.
#   ROTATION_NOTIFY (default 3) ROTATION_PAGE (default 10)        Q5 per chain / 15 min.
#   DRIFT_NOTIFY (default 20) DRIFT_PAGE (default 100)            Q7 per (chain,entryPoint) / 15 min.
#   Per-chain absorbed-loss caps, native base units (defaults = OQ-3 proposal).
#   Two env families are canonical (ANT-601 reconciliation — either family
#   alone suffices; the mechanism honors both with the same precedence):
#   BREAKER_CAP_<CHAIN>, or PID_RELAYER_BREAKER_CAP_LAMPORTS_<CHAIN>, or the
#   global PID_RELAYER_BREAKER_CAP_LAMPORTS. Resolution per chain:
#   PID_…_<CHAIN> > BREAKER_CAP_<CHAIN> > PID global > compiled default below.
#   Keep both families identical when both are set.
#   BREAKER_CAP_SOLANA (default 1000000)          lamports / 1h
#   BREAKER_CAP_STELLAR (default 1000000)         stroops / 1h
#   BREAKER_CAP_ETHEREUM (default 20000000000000000)  wei / 1h (0.02 ETH)
#   BREAKER_CAP_BASE (default 500000000000000)    wei / 1h (0.0005 ETH)
#   BREAKER_CAP_BSC (default 2000000000000000)    wei / 1h (0.002 BNB)
#   Unknown-chain rows use the tightest cap (solana default) — fail toward paging.
#
# Rollback: remove the cron line (or delete these files). Nothing was written to
# the DB, so there is nothing to undo there.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "CRITICAL: DATABASE_URL is not set (refusing to guess a target)" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "CRITICAL: psql not found in PATH" >&2
  exit 3
fi

REVOCATION_FLOOR="${REVOCATION_FLOOR:-5}"
REJECT_NOTIFY="${REJECT_NOTIFY:-10}"; REJECT_PAGE="${REJECT_PAGE:-50}"
ROTATION_NOTIFY="${ROTATION_NOTIFY:-3}"; ROTATION_PAGE="${ROTATION_PAGE:-10}"
DRIFT_NOTIFY="${DRIFT_NOTIFY:-20}"; DRIFT_PAGE="${DRIFT_PAGE:-100}"
CAP_SOLANA="${PID_RELAYER_BREAKER_CAP_LAMPORTS_SOLANA:-${BREAKER_CAP_SOLANA:-${PID_RELAYER_BREAKER_CAP_LAMPORTS:-1000000}}}"
CAP_STELLAR="${PID_RELAYER_BREAKER_CAP_LAMPORTS_STELLAR:-${BREAKER_CAP_STELLAR:-${PID_RELAYER_BREAKER_CAP_LAMPORTS:-1000000}}}"
CAP_ETHEREUM="${PID_RELAYER_BREAKER_CAP_LAMPORTS_ETHEREUM:-${BREAKER_CAP_ETHEREUM:-${PID_RELAYER_BREAKER_CAP_LAMPORTS:-20000000000000000}}}"
CAP_BASE="${PID_RELAYER_BREAKER_CAP_LAMPORTS_BASE:-${BREAKER_CAP_BASE:-${PID_RELAYER_BREAKER_CAP_LAMPORTS:-500000000000000}}}"
CAP_BSC="${PID_RELAYER_BREAKER_CAP_LAMPORTS_BSC:-${BREAKER_CAP_BSC:-${PID_RELAYER_BREAKER_CAP_LAMPORTS:-2000000000000000}}}"
CAP_UNKNOWN="$CAP_SOLANA"

Q1="SELECT COALESCE(se.metadata ->> 'chain', 'unknown'), COUNT(*) FILTER (WHERE se.\"createdAt\" > now() - interval '10 minutes'), COUNT(*) FILTER (WHERE se.\"createdAt\" <= now() - interval '10 minutes') FROM security_events se WHERE se.\"eventType\" IN ('credential.rotated', 'credential.revoked') AND se.\"createdAt\" > now() - interval '1 hour' GROUP BY 1;"
Q2="SELECT COALESCE(se.metadata ->> 'chain', 'unknown') || '/' || COALESCE(se.metadata ->> 'entryPoint', 'unknown') || '/' || COALESCE(se.metadata ->> 'cause', 'unknown'), COUNT(*) FROM security_events se WHERE se.\"eventType\" = 'intent.rejected' AND se.\"createdAt\" > now() - interval '15 minutes' GROUP BY 1;"
Q3="SELECT count(*) FROM security_events se WHERE se.\"createdAt\" > now() - interval '5 minutes' AND (se.\"eventType\" IN ('reconcile.formula_mismatch', 'reconcile.over_attested') OR (se.\"eventType\" LIKE '%.reconciled' AND (COALESCE((se.metadata ->> 'overAttested')::boolean, false) OR (se.metadata ->> 'protocolFee') IS DISTINCT FROM (se.metadata ->> 'protocolFeeExpected'))));"
Q4="SELECT s.chain, COALESCE(SUM(s.absorbed), 0)::bigint, EXISTS (SELECT 1 FROM security_events b WHERE b.\"eventType\" = 'relayer.breaker.opened' AND COALESCE(b.metadata ->> 'chain', 'unknown') = s.chain AND b.\"createdAt\" > now() - interval '1 hour') FROM (SELECT COALESCE(se.metadata ->> 'chain', 'unknown') AS chain, COALESCE(NULLIF(se.metadata ->> 'absorbed', ''), NULLIF(se.metadata ->> 'relayerAbsorbed', ''), '0')::numeric AS absorbed FROM security_events se WHERE (se.\"eventType\" = 'relayer.pnl' OR se.\"eventType\" LIKE '%.reconciled') AND se.\"createdAt\" > now() - interval '1 hour') s GROUP BY 1;"
Q5="SELECT COALESCE(se.metadata ->> 'chain', 'unknown'), COUNT(*) FROM security_events se WHERE se.\"eventType\" IN ('credential.rotation.unconfirmed', 'rotation.unconfirmed') AND se.\"createdAt\" > now() - interval '15 minutes' GROUP BY 1;"
Q6="SELECT count(*) FROM security_events se WHERE se.\"eventType\" = 'relay.parked_unreadable' AND se.\"createdAt\" > now() - interval '15 minutes';"
Q7="SELECT COALESCE(se.metadata ->> 'chain', 'unknown') || '/' || COALESCE(se.metadata ->> 'entryPoint', 'unknown'), COUNT(*) FROM security_events se WHERE se.\"eventType\" = 'quote.drift_rejected' AND se.\"createdAt\" > now() - interval '15 minutes' GROUP BY 1;"

run_q() {
  local out
  if ! out="$(psql "$DATABASE_URL" -X -q -t -A -F' ' -c "$1" 2>&1)"; then
    echo "CRITICAL: query failed: $out" >&2
    exit 3
  fi
  printf '%s' "$out"
}

cap_for() {
  case "$1" in
    solana) echo "$CAP_SOLANA" ;; stellar) echo "$CAP_STELLAR" ;;
    ethereum) echo "$CAP_ETHEREUM" ;; base) echo "$CAP_BASE" ;;
    bsc) echo "$CAP_BSC" ;; *) echo "$CAP_UNKNOWN" ;;
  esac
}

PAGES=(); NOTIFIES=()

# Q1: revocation spike — recent > 5 × baseline(=prior_50m/5) AND recent >= floor.
while IFS=' ' read -r chain recent prior; do
  [[ -z "$chain" ]] && continue
  if [[ "$recent" =~ ^[0-9]+$ && "$prior" =~ ^[0-9]+$ ]]; then
    # R-NFR-5: fire when recent_10m > 5 × trailing baseline. Baseline scaled to
    # a 10-min equivalent is prior_50m / 5, so 5 × baseline = prior_50m: the
    # exact test is recent > prior_50m (plus the absolute floor).
    if (( recent >= REVOCATION_FLOOR )) && (( recent > prior )); then
      PAGES+=("revocation spike: chain=$chain recent_10m=$recent prior_50m=$prior (>5x trailing baseline, R-NFR-5)")
    fi
  else
    echo "CRITICAL: unexpected Q1 output: $chain $recent $prior" >&2; exit 3
  fi
done <<< "$(run_q "$Q1")"

# Q2: intent rejections by bucket.
while IFS=' ' read -r bucket n; do
  [[ -z "$bucket" ]] && continue
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    if (( n >= REJECT_PAGE )); then PAGES+=("intent rejections $bucket: $n/15min >= page($REJECT_PAGE)");
    elif (( n >= REJECT_NOTIFY )); then NOTIFIES+=("intent rejections $bucket: $n/15min >= notify($REJECT_NOTIFY)"); fi
  else
    echo "CRITICAL: unexpected Q2 output: $bucket $n" >&2; exit 3
  fi
done <<< "$(run_q "$Q2")"

# Q3: ANY divergence in 5 min → page.
DIVERGENCE="$(run_q "$Q3" | tr -d '[:space:]')"
if [[ "$DIVERGENCE" =~ ^[0-9]+$ ]]; then
  if (( DIVERGENCE > 0 )); then PAGES+=("reconciliation divergence: $DIVERGENCE event(s)/5min (R-NFR-6 — see runbook §3)"); fi
else echo "CRITICAL: unexpected Q3 output: $DIVERGENCE" >&2; exit 3; fi

# Q4: absorbed loss vs cap (notify at 80%, page at 100%; page notes mechanism gap).
while IFS=' ' read -r chain absorbed opened; do
  [[ -z "$chain" ]] && continue
  if [[ "$absorbed" =~ ^[0-9]+$ ]]; then
    cap="$(cap_for "$chain")"
    if (( absorbed >= cap )); then
      gap=""; [[ "$opened" != "t" ]] && gap=" MECHANISM GAP: no relayer.breaker.opened for $chain in window"
      PAGES+=("absorbed loss $chain: $absorbed >= cap $cap base-units/1h$gap")
    elif (( absorbed * 5 >= cap * 4 )); then
      NOTIFIES+=("absorbed loss $chain approaching cap: $absorbed/ $cap base-units/1h (80%)")
    fi
  else
    echo "CRITICAL: unexpected Q4 output: $chain $absorbed $opened" >&2; exit 3
  fi
done <<< "$(run_q "$Q4")"

# Q5: rotation stuck.
while IFS=' ' read -r chain n; do
  [[ -z "$chain" ]] && continue
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    if (( n >= ROTATION_PAGE )); then PAGES+=("rotation unconfirmed $chain: $n/15min >= page($ROTATION_PAGE)");
    elif (( n >= ROTATION_NOTIFY )); then NOTIFIES+=("rotation unconfirmed $chain: $n/15min >= notify($ROTATION_NOTIFY)"); fi
  else
    echo "CRITICAL: unexpected Q5 output: $chain $n" >&2; exit 3
  fi
done <<< "$(run_q "$Q5")"

# Q6: parked-unreadable → always page.
PARKED="$(run_q "$Q6" | tr -d '[:space:]')"
if [[ "$PARKED" =~ ^[0-9]+$ ]]; then
  if (( PARKED > 0 )); then PAGES+=("resolve-then-act parked-unreadable: $PARKED intent(s)/15min need operator review (runbook §6)"); fi
else echo "CRITICAL: unexpected Q6 output: $PARKED" >&2; exit 3; fi

# Q7: drift spikes.
while IFS=' ' read -r bucket n; do
  [[ -z "$bucket" ]] && continue
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    if (( n >= DRIFT_PAGE )); then PAGES+=("quote drift $bucket: $n/15min >= page($DRIFT_PAGE)");
    elif (( n >= DRIFT_NOTIFY )); then NOTIFIES+=("quote drift $bucket: $n/15min >= notify($DRIFT_NOTIFY)"); fi
  else
    echo "CRITICAL: unexpected Q7 output: $bucket $n" >&2; exit 3
  fi
done <<< "$(run_q "$Q7")"

if (( ${#PAGES[@]} == 0 && ${#NOTIFIES[@]} == 0 )); then
  echo "OK: relayer H1 within thresholds (rev-spike/reject/divergence/pnl/rotation/park/drift checked)"
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
if (( ${#PAGES[@]} > 0 )); then post "$PAGE_URL" "PAGE relayer H1: $(printf '%s; ' "${PAGES[@]}")"; fi
if (( ${#NOTIFIES[@]} > 0 )); then post "$NOTIFY_URL" "NOTIFY relayer H1: $(printf '%s; ' "${NOTIFIES[@]}")"; fi

exit 2
