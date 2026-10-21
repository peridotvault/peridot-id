#!/usr/bin/env bash
# ANT-246: cron-friendly check for refresh.reuse_detected alert thresholds.
# READ-ONLY against the DB (SELECT only, via refresh-reuse-detected.sql).
#
# Usage:
#   DATABASE_URL=postgresql://... ./refresh-reuse-check.sh
#   DATABASE_URL=postgresql://... ALERT_WEBHOOK_URL=https://... ./refresh-reuse-check.sh
#
# Exit codes (Nagios/cron convention):
#   0 = OK (no threshold breached)
#   2 = ALERT (global and/or per-device threshold breached)
#   3 = usage/config error (DATABASE_URL unset, psql missing/failing)
#
# Cron (every 5 min, on a host with DATABASE_URL for the deployed DB):
#   */5 * * * *  DATABASE_URL='postgresql://...' /opt/peridot-id/deploy/alerts/refresh-reuse-check.sh
#
# Rollback: remove the cron line (or delete this directory). No app, schema,
# or data changes are made by this check — nothing to undo in the DB.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "CRITICAL: DATABASE_URL is not set (refusing to guess a target)" >&2
  exit 3
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "CRITICAL: psql not found in PATH" >&2
  exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/refresh-reuse-detected.sql"

# Split the two SELECTs: Q1 = global 5-min count (single value), Q2 = per-device rows.
# (Kept as separate inline queries mirroring the .sql file so -f output stays simple.)
Q1="SELECT count(*) FROM security_events se
LEFT JOIN devices d ON d.id = se.metadata ->> 'deviceId'
WHERE se.\"eventType\" = 'refresh.reuse_detected'
  AND se.\"createdAt\" > now() - interval '5 minutes'
  AND NOT (
    COALESCE((se.metadata ->> 'revokedAgoMs')::bigint, 9223372036854775807) <= 30000
    AND se.metadata ->> 'userAgent' IS NOT NULL
    AND d.\"userAgent\" IS NOT NULL
    AND se.metadata ->> 'userAgent' = d.\"userAgent\"
  );"

Q2="SELECT se.metadata ->> 'deviceId', count(*) FROM security_events se
LEFT JOIN devices d ON d.id = se.metadata ->> 'deviceId'
WHERE se.\"eventType\" = 'refresh.reuse_detected'
  AND se.\"createdAt\" > now() - interval '1 hour'
  AND NOT (
    COALESCE((se.metadata ->> 'revokedAgoMs')::bigint, 9223372036854775807) <= 30000
    AND se.metadata ->> 'userAgent' IS NOT NULL
    AND d.\"userAgent\" IS NOT NULL
    AND se.metadata ->> 'userAgent' = d.\"userAgent\"
  )
GROUP BY 1 HAVING count(*) > 1;"

if ! GLOBAL_COUNT="$(psql "$DATABASE_URL" -X -q -t -A -c "$Q1" 2>&1)"; then
  echo "CRITICAL: Q1 query failed: $GLOBAL_COUNT" >&2
  exit 3
fi
if ! DEVICE_ROWS="$(psql "$DATABASE_URL" -X -q -t -A -F' ' -c "$Q2" 2>&1)"; then
  echo "CRITICAL: Q2 query failed: $DEVICE_ROWS" >&2
  exit 3
fi

GLOBAL_COUNT="$(echo "$GLOBAL_COUNT" | tr -d '[:space:]')"
ALERT=0
MSG="OK: refresh.reuse_detected within thresholds (global_5m=$GLOBAL_COUNT)"

if [[ "$GLOBAL_COUNT" =~ ^[0-9]+$ ]] && (( GLOBAL_COUNT > 5 )); then
  MSG="ALERT: global non-race refresh.reuse_detected=$GLOBAL_COUNT > 5 per 5min"
  ALERT=1
elif ! [[ "$GLOBAL_COUNT" =~ ^[0-9]+$ ]]; then
  echo "CRITICAL: unexpected Q1 output: $GLOBAL_COUNT" >&2
  exit 3
fi

if [[ -n "${DEVICE_ROWS//[[:space:]]/}" ]]; then
  if (( ALERT == 1 )); then
    MSG="$MSG; ALSO per-device breach (1h): $(echo "$DEVICE_ROWS" | tr '\n' ';')"
  else
    MSG="ALERT: per-device non-race refresh.reuse_detected > 1/hr: $(echo "$DEVICE_ROWS" | tr '\n' ';')"
  fi
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
