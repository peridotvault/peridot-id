#!/usr/bin/env bash
set -euo pipefail

# Build and start the PeridotID stack on the Antigane VPS.
# Usage: ./deploy/up.sh [main|test]
#
# Secrets come from Infisical Cloud (project peridot-id-uf-w9):
#   /apps/api    — runtime secrets (DATABASE_URL, JWT_*, GOOGLE_*, DOKU_*, PID_*)
#   /apps/wallet — VITE_* (public build args)
# Docs are Mintlify-hosted since ANT-124 (apps/docs is the Mintlify source,
# board user deploys manually) — no VPS docs build, no docs secrets.
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
# Builds serially (api then app) so builds don't contend on a small VPS; BuildKit
# caches layers on the VPS so only changed apps rebuild. Requires the infra
# bootstrap (Traefik + `proxy` network) already up.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"

# Deploy meta (not secrets) — hardcoded per stack instead of living in Infisical.
# NEW_API_HOST is the ANT-99 dual-serve API hostname (old *.peridotvault.com hosts
# stay live via the same Traefik router — see compose.yaml).
if [ "$ENV" = "test" ]; then
  export ENV_SUFFIX="${ENV_SUFFIX:-sandbox.}"
  export NAMESPACE="${NAMESPACE:--test}"
  export NEW_API_HOST="${NEW_API_HOST:-sandbox-api.peridot.id}"
else
  export ENV_SUFFIX="${ENV_SUFFIX:-}"
  export NAMESPACE="${NAMESPACE:-}"
  export NEW_API_HOST="${NEW_API_HOST:-api.peridot.id}"
fi
# Hardening (ANT-121 security review §3): NEW_API_HOST lands verbatim in a Traefik
# Host() rule — reject anything that is not a plain hostname so a bad env value
# fails fast here instead of producing a broken router (or rule injection).
case "$NEW_API_HOST" in
  *[!a-zA-Z0-9.-]* | "" | .* | *.) echo "error: NEW_API_HOST invalid: '$NEW_API_HOST'" >&2; exit 1 ;;
esac

# ANT-99 dual-serve new hosts (DevOps ANT-118): deploy meta, not secrets —
# hardcoded per stack like ENV_SUFFIX above. Pre-set env vars win (override).
# NEW_API_HOST is owned by ANT-116 (api.peridot.id / sandbox-api.peridot.id);
# the dashboard API default below tracks the same canonical names so this stack
# stays correct even if that var is unset.
# NEW_DOCS_HOST (ANT-137) is the Mintlify target for the old-docs cutover
# redirect; it lands verbatim in a redirectregex replacement — same hostname
# hardening as NEW_API_HOST so a bad value fails fast here, not as an open redirect.
if [ "$ENV" = "test" ]; then
  export NEW_WALLET_HOST="${NEW_WALLET_HOST:-sandbox.peridot.id}"
  export NEW_DASHBOARD_HOST="${NEW_DASHBOARD_HOST:-sandbox-dashboard.peridot.id}"
  export NEW_DOCS_HOST="${NEW_DOCS_HOST:-sandbox-docs.peridot.id}"
  export DASHBOARD_API_URL="${DASHBOARD_API_URL:-https://sandbox-api.peridot.id}"
  export DASHBOARD_POPUP_URL="${DASHBOARD_POPUP_URL:-https://sandbox.peridot.id}"
  export DASHBOARD_PID_ENV="${DASHBOARD_PID_ENV:-sandbox}"
  export DASHBOARD_OTHER_WORKSPACE_URL="${DASHBOARD_OTHER_WORKSPACE_URL:-https://dashboard.peridot.id}"
else
  export NEW_WALLET_HOST="${NEW_WALLET_HOST:-peridot.id}"
  export NEW_DASHBOARD_HOST="${NEW_DASHBOARD_HOST:-dashboard.peridot.id}"
  export NEW_DOCS_HOST="${NEW_DOCS_HOST:-docs.peridot.id}"
  export DASHBOARD_API_URL="${DASHBOARD_API_URL:-https://api.peridot.id}"
  export DASHBOARD_POPUP_URL="${DASHBOARD_POPUP_URL:-https://peridot.id}"
  export DASHBOARD_PID_ENV="${DASHBOARD_PID_ENV:-production}"
  export DASHBOARD_OTHER_WORKSPACE_URL="${DASHBOARD_OTHER_WORKSPACE_URL:-https://sandbox-dashboard.peridot.id}"
fi
case "$NEW_DOCS_HOST" in
  *[!a-zA-Z0-9.-]* | "" | .* | *.) echo "error: NEW_DOCS_HOST invalid: '$NEW_DOCS_HOST'" >&2; exit 1 ;;
esac

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
      --path "/apps/api" --path "/apps/wallet" -- \
      docker compose -f "$SCRIPT_DIR/compose.yaml" "$@"
  else
    echo "warn: Infisical not configured (no token) — falling back to deploy/.env.$ENV" >&2
    ENV_FILE="$SCRIPT_DIR/.env.$ENV"
    [ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE missing (cp .env.$ENV.example .env.$ENV or provision Infisical)"; exit 1; }
    docker compose -f "$SCRIPT_DIR/compose.yaml" --env-file "$ENV_FILE" "$@"
  fi
}

echo "Deploying PeridotID [$ENV]..."
# Serial builds (small VPS): api + app are the proven set; dashboard
# (ANT-118) joins the same loop — same pattern, independent image.
# (docs left the loop in ANT-124: Mintlify-hosted, no VPS image to build.)
for s in api app dashboard; do
  echo "==> build $s"
  COMPOSE_PROJECT_NAME="$PROJECT" compose build "$s"
done

# --remove-orphans: drops stale containers (renamed services, interrupted recreates)
# that would otherwise squat on container names and fail the next recreate.
COMPOSE_PROJECT_NAME="$PROJECT" compose up -d --remove-orphans

echo "Done."