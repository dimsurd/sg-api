#!/usr/bin/env bash
# Drops and recreates the database, then loads schema + seed.
# Usage: DATABASE_URL=postgres://localhost:5432/star_generation bash db/reset.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f ../.env ]; then
  set -a; source ../.env; set +a
fi

: "${DATABASE_URL:?DATABASE_URL is not set (copy .env.example to .env)}"

DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
ADMIN_URL="${DATABASE_URL%/*}/postgres"

echo "Resetting database '$DB_NAME'..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB_NAME\";"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f seed.sql
echo "Done. Seeded logins use password: Password123!"
