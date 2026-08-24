#!/usr/bin/env bash
# Postaví jednorázový lokální Postgres, nahraje migrace a spustí RLS testy.
set -euo pipefail

SP="$(cd "$(dirname "$0")" && pwd)"
REPO_TESTS="$SP"
REPO=/Users/misak/sky-guard-portal
PGDATA="${TMPDIR:-/tmp}/skyguard-pgdata"
PGPORT=54329
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:$PATH"

command -v initdb >/dev/null || { echo "initdb není v PATH"; exit 1; }

# Čistý start pokaždé — testy nesmí záviset na zbytku z minula.
if [ -d "$PGDATA" ]; then
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
fi

echo "== initdb =="
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --locale=C >/dev/null

echo "== start (port $PGPORT) =="
pg_ctl -D "$PGDATA" -o "-p $PGPORT -c listen_addresses=localhost" -l "${TMPDIR:-/tmp}/skyguard-pg.log" -w start >/dev/null

cleanup() { pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; }
trap cleanup EXIT

PSQL="psql -h localhost -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -c "CREATE DATABASE skyguard_test" >/dev/null
DB="$PSQL -d skyguard_test"

echo "== bootstrap (náhrada Supabase auth) =="
$DB -f "$SP/local-bootstrap.sql" >/dev/null

echo "== migrace 1: perimetrické schéma =="
$DB -f "$REPO/supabase/migrations/20260824120000_perimeter_schema.sql" >/dev/null

echo "== migrace 2: site_grants =="
$DB -f "$REPO/supabase/migrations/20260824180000_site_grants.sql" >/dev/null

echo "== RLS testy =="
$DB -f "$REPO/supabase/tests/rls_site_grants.sql" 2>&1 | grep -E 'ok |FAIL|VŠECHNY|ERROR|CHYBA' || true
