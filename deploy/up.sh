#!/usr/bin/env bash
set -euo pipefail

# Build and start the PeridotID stack on the Antigane VPS.
# Usage: ./deploy/up.sh [main|test]
#
# Secrets come from Infisical Cloud (project peridot-id-uf-w9):
#   /apps/api    — runtime secrets (DATABASE_URL, JWT_*, GOOGLE_*, DOKU_*, PID_*)
#   /apps/web    — NEXT_PUBLIC_* (public build args)
#   /apps/wallet — EXPO_PUBLIC_* (public build args)
# No /deploy folder — it only duplicated the above (delete it in the UI).
# Env slugs match the script arg: main -> main, test -> test, local dev -> dev.
#
# Auth: local dev uses `infisical login` once. On a VPS the machine-identity
# credentials are persisted at /etc/peridot-id/infisical.env (0600 root):
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_ID / INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
# up.sh exchanges them for a short-lived token on each run. A pre-set
# INFISICAL_TOKEN is honored as-is.
# Fallback: INFISICAL_ENABLED=0 ./deploy/up.sh main reads deploy/.env.$ENV.
#
# Builds serially (api then web) so builds don't contend on a small VPS; BuildKit
# caches layers on the VPS so only changed apps rebuild. Requires the infra
# bootstrap (Traefik + `proxy` network) already up.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"

# Deploy meta (not secrets) — hardcoded per stack instead of living in Infisical.
if [ "$ENV" = "test" ]; then
  export ENV_SUFFIX="${ENV_SUFFIX:-sandbox.}"
  export NAMESPACE="${NAMESPACE:--test}"
else
  export ENV_SUFFIX="${ENV_SUFFIX:-}"
  export NAMESPACE="${NAMESPACE:-}"
fi

INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-51f99bb1-16c8-4b74-be1f-52657e066a93}"

# Persisted machine-identity creds (VPS). 0600 root, never in git.
INFISICAL_ENV_FILE="${INFISICAL_ENV_FILE:-/etc/peridot-id/infisical.env}"
# shellcheck disable=SC1090
[ -f "$INFISICAL_ENV_FILE" ] && . "$INFISICAL_ENV_FILE"

# Exchange universal-auth creds for a fresh access token (tokens are short-lived).
if [ -z "${INFISICAL_TOKEN:-}" ] && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ] \
    && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}" ] && command -v infisical >/dev/null 2>&1; then
  INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
    --client-secret "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
    --silent --plain 2>/dev/null | tail -n1)"
  export INFISICAL_TOKEN
fi

# ponytail: one wrapper so every compose call gets the same three paths.
compose() {
  if [ "${INFISICAL_ENABLED:-1}" = "1" ] && [ -n "${INFISICAL_TOKEN:-}" ] && command -v infisical >/dev/null 2>&1; then
    # First --path wins on collision; /apps/api owns shared names.
    infisical run --token "$INFISICAL_TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env "$ENV" \
      --path "/apps/api" --path "/apps/web" --path "/apps/wallet" -- \
      docker compose -f "$SCRIPT_DIR/compose.yaml" "$@"
  else
    echo "warn: Infisical not configured (no token) — falling back to deploy/.env.$ENV" >&2
    ENV_FILE="$SCRIPT_DIR/.env.$ENV"
    [ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE missing (cp .env.$ENV.example .env.$ENV or provision Infisical)"; exit 1; }
    docker compose -f "$SCRIPT_DIR/compose.yaml" --env-file "$ENV_FILE" "$@"
  fi
}

echo "Deploying PeridotID [$ENV]..."
for s in api web app; do
  echo "==> build $s"
  COMPOSE_PROJECT_NAME="$PROJECT" compose build "$s"
done

# --remove-orphans: drops stale containers (renamed services, interrupted recreates)
# that would otherwise squat on container names and fail the next recreate.
COMPOSE_PROJECT_NAME="$PROJECT" compose up -d --remove-orphans

echo "Done."