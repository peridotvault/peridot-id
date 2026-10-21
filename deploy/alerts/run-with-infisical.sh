#!/usr/bin/env bash
# ANT-385: run an alert check with secrets injected at runtime via Infisical.
# Usage: run-with-infisical.sh <main|test> <check-script> [args...]
#
# Mirrors deploy/up.sh auth: sources /etc/peridot-id/infisical.env (0600 root
# machine identity) or honors a pre-set INFISICAL_TOKEN, then execs
# `infisical run --env $ENV --path /apps/api -- <check>`. The check scripts
# themselves only ever see DATABASE_URL/ALERT_* as env vars — nothing is
# baked into crontab or disk. Called from cron (installed by install.sh),
# never by hand with secrets on the command line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:?usage: run-with-infisical.sh <main|test> <check-script> [args...]}"
CHECK="${2:?usage: run-with-infisical.sh <main|test> <check-script> [args...]}"
shift 2

INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-51f99bb1-16c8-4b74-be1f-52657e066a93}"
INFISICAL_ENV_FILE="${INFISICAL_ENV_FILE:-/etc/peridot-id/infisical.env}"
# shellcheck disable=SC1090
[ -f "$INFISICAL_ENV_FILE" ] && . "$INFISICAL_ENV_FILE"

if [ -z "${INFISICAL_TOKEN:-}" ] && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ] \
    && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}" ] && command -v infisical >/dev/null 2>&1; then
  INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
    --client-secret "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
    --silent --plain 2>/dev/null | tail -n1)"
  export INFISICAL_TOKEN
fi

if [ -z "${INFISICAL_TOKEN:-}" ] || ! command -v infisical >/dev/null 2>&1; then
  echo "run-with-infisical: no Infisical token available — skipping $CHECK (exit 3)" >&2
  exit 3
fi

exec infisical run --token "$INFISICAL_TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env "$ENV" \
  --path "/apps/api" -- "$SCRIPT_DIR/$CHECK" "$@"
