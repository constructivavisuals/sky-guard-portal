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

# Spustí testovací soubor a trvá na tom, aby doběhl do konce. Bez téhle
# kontroly by ERROR uprostřed souboru propadl přes `|| true` a běh by
# skončil zeleně s hláškou z jiného souboru.
run_test_file() {
  local file="$1"
  local out
  out=$($DB -f "$REPO/supabase/tests/$file" 2>&1) || true
  echo "$out" | grep -E 'ok |FAIL|VŠECHNY|ERROR' || true
  if ! echo "$out" | grep -q 'VŠECHNY TESTY PROŠLY'; then
    echo "SELHALO: $file nedoběhl do konce."
    exit 1
  fi
}

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
run_test_file rls_site_grants.sql

echo "== testy dronových detekcí a decision_reason =="
run_test_file drone_detections.sql

echo "== zápis zásahu podle výsledku =="
run_test_file dispatch_outcomes.sql

echo "== testy hlídek =="
run_test_file patrols.sql

echo "== anonymizace po lhůtě =="
run_test_file retention_anonymization.sql

echo "== práva anon a čtení cron_runs =="
run_test_file anon_and_cron_read.sql

echo "== schopnosti kamer =="
run_test_file camera_capabilities.sql

echo "== testy místa a směru kamer =="
run_test_file camera_location.sql

echo "== práva na pomocné funkce =="
run_test_file function_grants.sql

echo "== auditní deník =="
run_test_file audit_write.sql

echo "== dopravci a avizované příjezdy =="
run_test_file announced_arrivals.sql

echo "== evidence běhů cronu =="
run_test_file cron_runs.sql

echo "== odběry a předvolby notifikací =="
run_test_file push_notifications.sql

echo "== zpevnění ingestu =="
run_test_file ingest_hardening.sql

echo "== evidence vjezdů =="
run_test_file vehicle_passages.sql

echo "== kontrola seedu Vysoké Veselí =="
run_test_file seed_vysoke_veseli.sql

# Regrese na past z auditu (4A): základní migrace definuje
# site_is_visible() a pozdější ji rozšiřuje o granty. Když se ta
# základní pustí znovu, nesmí to izolaci klientů rozvolnit.
echo "== znovuspuštění základní migrace nesmí rozvolnit izolaci =="
# Bez -q, ať je případná chyba vidět: kdyby migrace spadla dřív, než
# dojde na definice funkcí, test by prošel, aniž by cokoli ověřil.
$DB -f "$REPO/supabase/migrations/20260824120000_perimeter_schema.sql" >/dev/null
run_test_file rls_deny_by_default.sql

echo "== a po znovuspuštění té pozdější se přístup vrátí =="
$DB -f "$REPO/supabase/migrations/20260824180000_site_grants.sql" >/dev/null
run_test_file rls_site_grants.sql
# Totéž pro site_is_armed(): znovuspuštění základní migrace nesmí
# odstranit kontrolu viditelnosti, kterou přidala 20260829180000.
run_test_file function_grants.sql

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
echo "== shoda plate_normalize() v SQL a normalizePlate() v TypeScriptu =="
# Značku normalizují taky dvě implementace: databáze v unikátním
# a funkčním indexu, portál při párování se seznamem. Když se rozejdou,
# tiše přestane fungovat párování — nežádoucí auto projde jako neznámé
# a známé jako nepřečtené.
#
# V constructiva-portal byla tatáž úprava opsaná na čtyřech místech
# a netestovaná vůbec; proto je tenhle krok tady.
PLATES='1AB 2345|1ab2345|1AB-2345|1.a.b/2345|   |---|ČAU 123|1AB 2345 🚚|AA00BB11|a|9zz-0000'

SQL_OUT=$(
  $DB -t -A -F '|' -c "
    SELECT string_agg(plate_normalize(p), '|' ORDER BY ord)
      FROM unnest(string_to_array(\$\$$PLATES\$\$, '|')) WITH ORDINALITY AS x(p, ord);"
)
TS_OUT=$(cd "$REPO" && node --input-type=module -e "
  const {normalizePlate} = await import('$REPO/src/lib/plates.ts');
  console.log('$PLATES'.split('|').map(normalizePlate).join('|'));
" 2>/dev/null | tail -1)

if [ "$SQL_OUT" = "$TS_OUT" ]; then
  echo "ok    značky — SQL i TS: $SQL_OUT"
else
  echo "FAIL  značky — SQL: $SQL_OUT"
  echo "                TS:  $TS_OUT"
  FAILED=1
fi

[ "$FAILED" -eq 0 ] && echo "VŠECHNY TESTY PROŠLY" || exit 1
