#!/usr/bin/env bash
# ANT-385: idempotently install the alert cron lines for one stack.
# Usage: install.sh <main|test>
#
# Derives the repo path from this file's location (no hardcoded /opt path —
# prod and sandbox checkouts live at different prefixes). Each cron line
# calls run-with-infisical.sh so DATABASE_URL is injected at runtime from
# Infisical; crontab itself holds no secrets. Safe to re-run: existing
# managed lines (tagged #peridot-alert) are replaced, nothing else touched.
# Rollback: `crontab -l | grep -v '#peridot-alert' | crontab -`.
# Called by deploy/up.sh after `up -d`; also runnable by hand on the VPS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:?usage: install.sh <main|test>}"

if [ "$ENV" = "test" ]; then
  ALERT_ENV="sandbox"
else
  ALERT_ENV="production"
fi

RUNNER="$SCRIPT_DIR/run-with-infisical.sh"

# Both checks run on each VPS scoped to that stack's ALERT_ENV; cadence
# mirrors deploy/alerts/README.md.
ENTRIES=$(cat <<EOF
*/5 * * * *  ALERT_ENV=$ALERT_ENV $RUNNER $ENV refresh-reuse-check.sh #peridot-alert
*/15 * * * *  ALERT_ENV=$ALERT_ENV $RUNNER $ENV faucet-abuse-check.sh #peridot-alert
EOF
)

CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$CURRENT" | grep -v '#peridot-alert' || true)"
if [ -n "$FILTERED" ]; then
  printf '%s\n%s\n' "$FILTERED" "$ENTRIES" | crontab -
else
  printf '%s\n' "$ENTRIES" | crontab -
fi

echo "alert crons installed for [$ENV] (ALERT_ENV=$ALERT_ENV):"
printf '%s\n' "$ENTRIES"
