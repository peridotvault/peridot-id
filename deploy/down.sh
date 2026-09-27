#!/usr/bin/env bash
set -euo pipefail

# Stop the PeridotID stack.
# Usage: ./deploy/down.sh [main|test]
# ponytail: down needs no secrets — just the project name. No --env-file,
# no Infisical call.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

PROJECT="peridot-id"
[ "$ENV" = "test" ] && PROJECT="peridot-id-test"
shift || true

COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f "$SCRIPT_DIR/compose.yaml" down "$@"