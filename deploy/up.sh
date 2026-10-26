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

# ANT-385: immutable images. Every build is tagged with the short git SHA
# (TAG defaults to it; pre-set TAG wins for tag-switch rollbacks) and :latest
# is re-pointed at the same image IDs so `latest` stays a usable alias.
# Rollback without rebuild: TAG=<prev-sha> SKIP_BUILD=1 ./deploy/up.sh <env>.
# Each deploy appends one line to deploy/.deploys.log (gitignored).
if [ -z "${GIT_SHA:-}" ]; then
  GIT_SHA="$(git -C "$SCRIPT_DIR/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export GIT_SHA
fi
export TAG="${TAG:-$GIT_SHA}"

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"

# Deploy meta (not secrets) — hardcoded per stack instead of living in Infisical.
# NEW_API_HOST is the canonical API hostname (ANT-405 hard cutover — one host
# per Traefik router, see compose.yaml).
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

# Canonical peridot.id hosts (ANT-405 hard cutover): deploy meta, not secrets —
# hardcoded per stack like ENV_SUFFIX above. Pre-set env vars win (override).
# The dashboard API default below tracks the same canonical API names so this
# stack stays correct even if NEW_API_HOST is unset.
# (Docs are Mintlify-hosted at docs.peridot.id — no VPS redirect anymore, so no
# docs host var is exported here.)
if [ "$ENV" = "test" ]; then
  export NEW_WALLET_HOST="${NEW_WALLET_HOST:-sandbox.peridot.id}"
  export NEW_DASHBOARD_HOST="${NEW_DASHBOARD_HOST:-sandbox-dashboard.peridot.id}"
  # ANT-693: the wallet bakes VITE_API_URL at build time (compose → Dockerfile.app).
  # Without a per-stack default the sandbox wallet silently baked the prod API
  # fallback, minting pid_codes in the prod DB that sandbox-api can never
  # consume (`sso_code_invalid` on every exchange). Same canonical-API rule as
  # DASHBOARD_API_URL below — pre-set env vars still win.
  export VITE_API_URL="${VITE_API_URL:-https://sandbox-api.peridot.id}"
  export DASHBOARD_API_URL="${DASHBOARD_API_URL:-https://sandbox-api.peridot.id}"
  export DASHBOARD_POPUP_URL="${DASHBOARD_POPUP_URL:-https://sandbox.peridot.id}"
  export DASHBOARD_PID_ENV="${DASHBOARD_PID_ENV:-sandbox}"
  export DASHBOARD_OTHER_WORKSPACE_URL="${DASHBOARD_OTHER_WORKSPACE_URL:-https://dashboard.peridot.id}"
else
  export NEW_WALLET_HOST="${NEW_WALLET_HOST:-peridot.id}"
  export NEW_DASHBOARD_HOST="${NEW_DASHBOARD_HOST:-dashboard.peridot.id}"
  export VITE_API_URL="${VITE_API_URL:-https://api.peridot.id}"
  export DASHBOARD_API_URL="${DASHBOARD_API_URL:-https://api.peridot.id}"
  export DASHBOARD_POPUP_URL="${DASHBOARD_POPUP_URL:-https://peridot.id}"
  export DASHBOARD_PID_ENV="${DASHBOARD_PID_ENV:-production}"
  export DASHBOARD_OTHER_WORKSPACE_URL="${DASHBOARD_OTHER_WORKSPACE_URL:-https://sandbox-dashboard.peridot.id}"
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
# Faucet prod lock (ANT-290, board order 2026-10-21): strict abort for main
# deploys that would enable the sandbox faucet. Logic lives in
# deploy/faucet-preflight.sh (sourced — function only, so it stays unit
# testable); this block runs for ENV=main only, test stack unaffected.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/faucet-preflight.sh"
if [ "$ENV" = "main" ]; then
  faucet_preflight_main
fi
# Serial builds (small VPS): api + app are the proven set; dashboard
# (ANT-118) joins the same loop — same pattern, independent image.
# (docs left the loop in ANT-124: Mintlify-hosted, no VPS image to build.)
# SKIP_BUILD=1 skips the loop for tag-switch rollbacks (TAG=<prev-sha>).
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  for s in api app dashboard; do
    echo "==> build $s"
    COMPOSE_PROJECT_NAME="$PROJECT" compose build "$s"
  done
else
  echo "==> SKIP_BUILD=1: reusing existing images (rollback path)"
fi

# ANT-347 LOW-5: pre-deploy migration check — fail fast if the DB is
# unreachable or migrations have drifted, BEFORE swapping containers.
# `migrate status` is read-only; the actual `migrate deploy` runs at API
# container boot (Dockerfile.api CMD). Rollback: fix DB/schema, re-run up.sh.
echo "==> prisma migrate status (pre-deploy check)"
# `migrate status` also exits 1 when migrations are merely *pending* — they get
# applied at API boot by `migrate deploy`, so only real drift/failure blocks.
set +e
MIGRATE_STATUS="$(COMPOSE_PROJECT_NAME="$PROJECT" compose run --rm api node_modules/.bin/prisma migrate status 2>&1)"
MIGRATE_RC=$?
set -e
printf '%s\n' "$MIGRATE_STATUS"
case "$MIGRATE_STATUS" in
  *"have failed"* | *"Drift detected"*) MIGRATE_RC=1 ;;
  *"have not yet been applied"*)
    if [ "$MIGRATE_RC" -ne 0 ]; then
      echo "warn: pending migrations — applied by migrate deploy at API boot" >&2
      MIGRATE_RC=0
    fi ;;
esac
if [ "$MIGRATE_RC" -ne 0 ]; then
  echo "error: prisma migrate status failed — fix the DB/schema before deploying" >&2
  exit 1
fi

# --remove-orphans: drops stale containers (renamed services, interrupted recreates)
# that would otherwise squat on container names and fail the next recreate.
COMPOSE_PROJECT_NAME="$PROJECT" compose up -d --remove-orphans

# ANT-385: alias :latest to the just-built :TAG images, record the deploy,
# and (re)install the alert crons. `docker tag` never pulls — source images
# were just built above (or reused via SKIP_BUILD=1).
for s in api app dashboard; do
  SRC="peridot-id-$s${NAMESPACE}:$TAG"
  if docker image inspect "$SRC" >/dev/null 2>&1; then
    docker tag "$SRC" "peridot-id-$s${NAMESPACE}:latest"
  else
    echo "warn: image $SRC not found — :latest alias skipped for $s" >&2
  fi
done
printf '%s env=%s sha=%s tag=%s\n' "$(date -u +%FT%TZ)" "$ENV" "$GIT_SHA" "$TAG" >> "$SCRIPT_DIR/.deploys.log"

# Alert crons (ANT-385 observability): idempotent, runtime secrets only.
# Warn-and-continue so a crontab failure can't fail an otherwise good deploy;
# verify with `crontab -l | grep peridot-alert`. Opt out: INSTALL_ALERT_CRONS=0.
if [ "${INSTALL_ALERT_CRONS:-1}" = "1" ]; then
  if bash "$SCRIPT_DIR/alerts/install.sh" "$ENV"; then
    crontab -l 2>/dev/null | grep 'peridot-alert' || true
  else
    echo "warn: alert cron install failed — run deploy/alerts/install.sh $ENV on the VPS" >&2
  fi
fi

echo "Done."