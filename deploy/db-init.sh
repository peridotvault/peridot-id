#!/usr/bin/env bash
set -euo pipefail

# Create the PeridotID database + role on the shared infra Postgres, then run Prisma
# migrations. Idempotent — safe to run repeatedly.
# Usage: ./deploy/db-init.sh [main|test]
#
# Requires the infra repo at /opt/infra and the shared Postgres `services` profile up.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-main}"

ENV_FILE="$SCRIPT_DIR/.env.$ENV"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE missing"; exit 1; }

SUFFIX=""
[ "$ENV" = "test" ] && SUFFIX="-test"

DB="peridot_id${SUFFIX}"
ROLE="peridot_id${SUFFIX}"

INFRA="${INFRA_DIR:-/opt/infra}"
[ -x "$INFRA/scripts/createdb.sh" ] || { echo "error: $INFRA/scripts/createdb.sh not found"; exit 1; }

echo "creating db/role $DB..."
PASSFILE=$(mktemp)
"$INFRA/scripts/createdb.sh" "$DB" "$ROLE" >> "$PASSFILE"

# generated password printed by createdb.sh when it created a new role
GEN_PASS="$(tail -1 "$PASSFILE" | sed -n 's/.*generated password for role.*: //p')"
rm -f "$PASSFILE"

if [ -n "$GEN_PASS" ] && ! grep -q "^DATABASE_URL=" "$ENV_FILE"; then
  echo "generated role password: $GEN_PASS"
  echo "add these to $ENV_FILE:"
  echo "  DATABASE_URL=postgresql://$ROLE:$GEN_PASS@postgres:5432/$DB"
  echo "  DIRECT_URL=postgresql://$ROLE:$GEN_PASS@postgres:5432/$DB"
  exit 0
fi

# Run migrations from the app repo using the env's DATABASE_URL.
export DATABASE_URL DIR_URL
DATABASE_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
DIRECT_URL="$(grep '^DIRECT_URL=' "$ENV_FILE" | cut -d= -f2-)"

cd "$SCRIPT_DIR/.."
echo "running prisma migrate deploy..."
pnpm --filter @peridotvault/pid-api exec prisma migrate deploy
echo "done."