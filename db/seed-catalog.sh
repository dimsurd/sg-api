#!/usr/bin/env bash
# Loads the optional demo catalogue (db/seed-catalog.sql) into DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${DATABASE_URL:-}" ] && [ -f ../.env ]; then
  set -a; source ../.env; set +a
fi
: "${DATABASE_URL:?DATABASE_URL is not set (copy .env.example to .env)}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f seed-catalog.sql
echo "Demo catalogue loaded: $(psql "$DATABASE_URL" -tA -c 'select count(*) from classes') classes in total."
