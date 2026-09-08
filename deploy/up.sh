#!/usr/bin/env bash
set -euo pipefail

# Build and start the PeridotID stack on the Antigane VPS.
# Usage: ./deploy/up.sh [main|test]
#
# Builds serially (api then web) so builds don't contend on a small VPS; BuildKit
# caches layers on the VPS so only changed apps rebuild. Requires the infra
# bootstrap (Traefik + `proxy` network) already up.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

ENV_FILE="$SCRIPT_DIR/.env.$ENV"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE missing (cp .env.$ENV.example .env.$ENV)"; exit 1; }

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"

COMPOSE=(docker compose -f "$SCRIPT_DIR/compose.yaml" --env-file "$ENV_FILE")

echo "Deploying PeridotID [$ENV]..."
for s in api web app; do
  echo "==> build $s"
  COMPOSE_PROJECT_NAME="$PROJECT" "${COMPOSE[@]}" build "$s"
done

# --remove-orphans: drops stale containers (renamed services, interrupted recreates)
# that would otherwise squat on container names and fail the next recreate.
COMPOSE_PROJECT_NAME="$PROJECT" "${COMPOSE[@]}" up -d --remove-orphans

echo "Done. Check status with: docker compose -f deploy/compose.yaml --env-file deploy/.env.$ENV ps"