#!/usr/bin/env bash
# ANT-290: cron-friendly check for sandbox-faucet abuse alert thresholds.
# READ-ONLY against the DB (SELECT only, via faucet-abuse-detected.sql).
#
# Signal: fiat_ledger_entries with kind='fiat_issue' AND source='<FAUCET_SOURCE>'
# (backend contract, ANT-289 FR-2). Only successful mints leave rows.
#
# Usage:
#   DATABASE_URL=postgresql://... ./faucet-abuse-check.sh
#   DATABASE_URL=postgresql://... ALERT_ENV=production ./faucet-abuse-check.sh
#   DATABASE_URL=postgresql://... ALERT_WEBHOOK_URL=https://... ./faucet-abuse-check.sh
#
# Env overrides (thresholds proposed per ANT-287 §6 — CTO confirms via OQ-1):
#   ALERT_ENV=production|sandbox   (default: sandbox)
#   FAUCET_SOURCE                  (default: faucet — must match backend)
#   FAUCET_HOURLY_MAX              (default: 30  — 3x the 10/day cap attempts)
#   FAUCET_DAILY_MAX_COUNT         (default: 10)
#   FAUCET_DAILY_MAX_IDR           (default: 100000)
#
# Exit codes (Nagios/cron convention):
#   0 = OK (no threshold breached)
#   2 = ALERT (abuse / cap-bypass / prod-zero breached)
#   3 = usage/config error (DATABASE_URL unset, psql missing/failing)
#
# Cron (sandbox: every 15 min; production: every 5 min — ANY faucet row there
# is a critical finding since the route must be absent, AC-F2):
#   */15 * * * *  DATABASE_URL='postgresql://...' ALERT_ENV=sandbox /opt/peridot-id/deploy/alerts/faucet-abuse-check.sh
#   */5  * * * *  DATABASE_URL='postgresql://...' ALERT_ENV=production /opt/peridot-id/deploy/alerts/faucet-abuse-check.sh
#
# Rollback: remove the cron line(s). No app, schema, or data changes are made
# by this check — nothing to undo in the DB.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "CRITICAL: DATABASE_URL is not set (refusing to guess a target)" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "CRITICAL: psql not found in PATH" >&2
  exit 3
fi

ALERT_ENV="${ALERT_ENV:-sandbox}"
FAUCET_SOURCE="${FAUCET_SOURCE:-faucet}"
FAUCET_HOURLY_MAX="${FAUCET_HOURLY_MAX:-30}"
FAUCET_DAILY_MAX_COUNT="${FAUCET_DAILY_MAX_COUNT:-10}"
FAUCET_DAILY_MAX_IDR="${FAUCET_DAILY_MAX_IDR:-100000}"

# Basic numeric guard so a bad env value fails fast here, not as SQL.
for v in "$FAUCET_HOURLY_MAX" "$FAUCET_DAILY_MAX_COUNT" "$FAUCET_DAILY_MAX_IDR"; do
  [[ "$v" =~ ^[0-9]+$ ]] || { echo "CRITICAL: non-numeric faucet threshold: $v" >&2; exit 3; }
done

# psql variables ($source etc.) are substituted by psql itself on stdin,
# never interpolated into shell — a crafted FAUCET_SOURCE cannot break out
# of the quoted-literal context. NOTE: queries go via stdin, not -c, because
# psql does not interpolate :vars in -c strings (verified on psql 18).
Q1="SELECT pid, count(*), coalesce(sum(\"amountIdr\"), 0) FROM fiat_ledger_entries
WHERE kind = 'fiat_issue' AND source = :'source'
  AND \"createdAt\" > now() - interval '1 hour'
GROUP BY 1 HAVING count(*) > :hourly_max;"

Q2="SELECT pid, count(*), coalesce(sum(\"amountIdr\"), 0) FROM fiat_ledger_entries
WHERE kind = 'fiat_issue' AND source = :'source'
  AND \"createdAt\" > now() - interval '24 hours'
GROUP BY 1 HAVING count(*) > :daily_count OR coalesce(sum(\"amountIdr\"), 0) > :daily_idr;"

Q3="SELECT count(*) FROM fiat_ledger_entries
WHERE kind = 'fiat_issue' AND source = :'source';"

PSQL=(psql "$DATABASE_URL" -X -q -t -A -F' '
  -v "source=$FAUCET_SOURCE"
  -v "hourly_max=$FAUCET_HOURLY_MAX"
  -v "daily_count=$FAUCET_DAILY_MAX_COUNT"
  -v "daily_idr=$FAUCET_DAILY_MAX_IDR")

if ! HOURLY_ROWS="$(printf '%s' "$Q1" | "${PSQL[@]}" 2>&1)"; then
  echo "CRITICAL: Q1 query failed: $HOURLY_ROWS" >&2
  exit 3
fi
if ! DAILY_ROWS="$(printf '%s' "$Q2" | "${PSQL[@]}" 2>&1)"; then
  echo "CRITICAL: Q2 query failed: $DAILY_ROWS" >&2
  exit 3
fi
if ! ALL_TIME="$(printf '%s' "$Q3" | "${PSQL[@]}" 2>&1)"; then
  echo "CRITICAL: Q3 query failed: $ALL_TIME" >&2
  exit 3
fi
ALL_TIME="$(echo "$ALL_TIME" | tr -d '[:space:]')"
[[ "$ALL_TIME" =~ ^[0-9]+$ ]] || { echo "CRITICAL: unexpected Q3 output: $ALL_TIME" >&2; exit 3; }

ALERT=0
MSG="OK: faucet within thresholds (env=$ALERT_ENV hourly_max=$FAUCET_HOURLY_MAX all_time_mints=$ALL_TIME)"

if [[ -n "${HOURLY_ROWS//[[:space:]]/}" ]]; then
  MSG="ALERT: faucet abuse — identity over $FAUCET_HOURLY_MAX mints/hour (1h): $(echo "$HOURLY_ROWS" | tr '\n' ';')"
  ALERT=1
fi

if [[ -n "${DAILY_ROWS//[[:space:]]/}" ]]; then
  DETAIL="cap-bypass — identity over $FAUCET_DAILY_MAX_COUNT/day or Rp$FAUCET_DAILY_MAX_IDR/24h: $(echo "$DAILY_ROWS" | tr '\n' ';')"
  if (( ALERT == 1 )); then MSG="$MSG; ALSO $DETAIL"; else MSG="ALERT: faucet $DETAIL"; fi
  ALERT=1
fi

# Prod-zero invariant (AC-F2, ongoing): the faucet route must be absent on
# production, so ANY faucet-source ledger row there is critical. Sandbox runs
# only report the count (faucet is supposed to mint there).
if [[ "$ALERT_ENV" == "production" ]] && (( ALL_TIME > 0 )); then
  DETAIL="PROD-ZERO violated — $ALL_TIME faucet-source ledger row(s) on production (route must be absent)"
  if (( ALERT == 1 )); then MSG="$MSG; ALSO $DETAIL"; else MSG="ALERT: faucet $DETAIL"; fi
  ALERT=1
fi

echo "$MSG"
if (( ALERT == 1 )) && [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  curl -fsS -m 10 -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    --data "$(printf '{"text": %s}' "$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null || echo "WARNING: webhook POST failed (alert still reported via stdout/exit code)" >&2
fi

(( ALERT == 1 )) && exit 2
exit 0
