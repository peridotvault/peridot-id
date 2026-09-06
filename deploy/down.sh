#!/usr/bin/env bash
set -euo pipefail

# Stop the PeridotID stack.
# Usage: ./deploy/down.sh [main|test]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

ENV_FILE="$SCRIPT_DIR/.env.$ENV"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE missing"; exit 1; }

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"

COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f "$SCRIPT_DIR/compose.yaml" --env-file "$ENV_FILE" down "$@"