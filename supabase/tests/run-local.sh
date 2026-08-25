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

# psql \i v testech řeší cesty k migracím relativně ke kořeni repa.
cd "$REPO"

PSQL="psql -h localhost -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -c "CREATE DATABASE skyguard_test" >/dev/null
DB="$PSQL -d skyguard_test"

echo "== bootstrap (náhrada Supabase auth) =="
$DB -f "$SP/local-bootstrap.sql" >/dev/null

# Migrace v pořadí, testy až po nich.
for m in "$REPO"/supabase/migrations/*.sql; do
  echo "== migrace $(basename "$m") =="
  $DB -f "$m" >/dev/null
done

echo "== RLS testy rozsahu =="
$DB -f "$REPO/supabase/tests/rls_site_grants.sql" 2>&1 | grep -E 'ok |FAIL|VŠECHNY|ERROR' || true

echo "== testy dronových detekcí a decision_reason =="
$DB -f "$REPO/supabase/tests/drone_detections.sql" 2>&1 | grep -E 'ok |FAIL|VŠECHNY|ERROR' || true

echo "== testy hlídek =="
$DB -f "$REPO/supabase/tests/patrols.sql" 2>&1 | grep -E 'ok |FAIL|VŠECHNY|ERROR' || true

echo "== shoda site_is_armed() v SQL a isSiteArmed() v TypeScriptu =="
# Ostrý režim počítají dvě nezávislé implementace: databáze při
# potlačování výjezdů, portál při vykreslování odznaku. Když se
# rozejdou, portál lže o stavu střežení — tenhle krok to odhalí.
$DB -q -c "
INSERT INTO sites (id,name,timezone,armed_from,armed_to,armed_days) VALUES
 ('00000000-0000-0000-0000-00000000aa01','Parita noc','Europe/Prague','18:00','06:00',ARRAY[1,2,3,4,5]),
 ('00000000-0000-0000-0000-00000000aa02','Parita den','Europe/Prague','08:00','17:00',ARRAY[6,7])
ON CONFLICT (id) DO NOTHING;" >/dev/null 2>&1

CASES='2026-07-15T16:30:00Z 2026-01-15T16:30:00Z 2026-01-15T17:00:00Z 2026-08-28T20:00:00+02:00 2026-08-29T02:00:00+02:00 2026-08-29T20:00:00+02:00 2026-08-30T02:00:00+02:00 2026-08-31T18:00:00+02:00 2026-09-01T06:00:00+02:00 2026-03-29T00:30:00Z 2026-03-29T01:30:00Z 2026-10-25T00:30:00Z 2026-10-25T01:30:00Z 2026-08-29T12:00:00+02:00'
ARR=$(echo $CASES | sed "s/[^ ]*/'&'::timestamptz/g" | tr ' ' ',')

FAILED=0
for SITE in aa01 aa02; do
  SQL=$($DB -t -A -c "SELECT string_agg(CASE WHEN site_is_armed('00000000-0000-0000-0000-00000000$SITE', ts) THEN 't' ELSE 'f' END, '' ORDER BY ord) FROM unnest(ARRAY[$ARR]) WITH ORDINALITY AS x(ts, ord);" | tr -d ' \n')
  TS=$(cd "$REPO" && node --input-type=module -e "
    const {isSiteArmed} = await import('$REPO/src/types/database.ts');
    const sites = { aa01:{timezone:'Europe/Prague',armed_from:'18:00:00',armed_to:'06:00:00',armed_days:[1,2,3,4,5]},
                    aa02:{timezone:'Europe/Prague',armed_from:'08:00:00',armed_to:'17:00:00',armed_days:[6,7]} };
    console.log('$CASES'.split(' ').map(t => isSiteArmed(sites['$SITE'], new Date(t)) ? 't' : 'f').join(''));
  " 2>/dev/null | tail -1)
  if [ "$SQL" = "$TS" ]; then
    echo "ok    $SITE — SQL i TS: $SQL"
  else
    echo "FAIL  $SITE — SQL: $SQL  TS: $TS"
    FAILED=1
  fi
done
[ "$FAILED" -eq 0 ] && echo "VŠECHNY TESTY PROŠLY" || exit 1
