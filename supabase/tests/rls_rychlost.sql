-- ═══════════════════════════════════════════════════════════════════
-- Test migrace 20261116120000 (rychlé RLS).
--
-- Migrace mění TVAR čtecích politik, ne pravidlo. Tenhle test to
-- hlídá: pro každého uživatele a každou dotčenou tabulku porovná, kolik
-- řádků vidí přes novou politiku, s tím, kolik by pustila původní
-- podmínka (site_is_visible() na každém řádku).
--
-- Druhá polovina hlídá, aby se politiky do pomalého tvaru nevrátily:
-- žádná čtecí politika velkých tabulek nesmí volat funkci nad sloupcem
-- řádku.
--
-- Běží v transakci ukončené ROLLBACKem.
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;
SET search_path = public, extensions;

-- ── Data ───────────────────────────────────────────────────────────
-- Triggery (audit, dispatch) se při plnění vypnou; testuje se čtení.

SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-00000000f0a1'),
  ('00000000-0000-0000-0000-00000000f0b1'),
  ('00000000-0000-0000-0000-00000000f0c1'),
  ('00000000-0000-0000-0000-00000000f0d1');

INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-00000000f0a1', 'admin@example.com', 'admin'),
  ('00000000-0000-0000-0000-00000000f0b1', 'operator@example.com', 'operator'),
  ('00000000-0000-0000-0000-00000000f0c1', 'klient@example.com', 'viewer'),
  ('00000000-0000-0000-0000-00000000f0d1', 'bez-grantu@example.com', 'viewer');

INSERT INTO sites (id, name) VALUES
  ('00000000-0000-0000-0000-00000000f5a1', 'Rychlost A'),
  ('00000000-0000-0000-0000-00000000f5b1', 'Rychlost B');

-- Klient vidí jen A, operátor jen B. Bez grantu nic.
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f5a1'),
  ('00000000-0000-0000-0000-00000000f0b1', '00000000-0000-0000-0000-00000000f5b1');

INSERT INTO zones (id, site_id, name) VALUES
  ('00000000-0000-0000-0000-00000000f6a1', '00000000-0000-0000-0000-00000000f5a1', 'Zóna A'),
  ('00000000-0000-0000-0000-00000000f6b1', '00000000-0000-0000-0000-00000000f5b1', 'Zóna B');

INSERT INTO cameras (id, site_id, name, serial_number) VALUES
  ('00000000-0000-0000-0000-00000000f7a1', '00000000-0000-0000-0000-00000000f5a1', 'KA1', 'rychlost-ka1'),
  ('00000000-0000-0000-0000-00000000f7a2', '00000000-0000-0000-0000-00000000f5a1', 'KA2', 'rychlost-ka2'),
  ('00000000-0000-0000-0000-00000000f7b1', '00000000-0000-0000-0000-00000000f5b1', 'KB1', 'rychlost-kb1');

-- Nestejné počty na lokalitách, aby se záměna A za B projevila.
-- Různé časy: (camera_id, detected_at) je pojistka proti opakování.
INSERT INTO detections (id, camera_id, site_id, source, detected_at)
SELECT gen_random_uuid(), c.id, c.site_id, 'camera', now() - n * interval '1 minute'
FROM cameras c, generate_series(1, 7) n
WHERE c.serial_number LIKE 'rychlost-%';

INSERT INTO camera_recordings (camera_id, started_at)
SELECT c.id, now() - n * interval '1 minute'
FROM cameras c, generate_series(1, 5) n
WHERE c.serial_number LIKE 'rychlost-%';

INSERT INTO vehicle_passages (site_id, detection_id)
SELECT d.site_id, d.id FROM detections d
JOIN cameras c ON c.id = d.camera_id
WHERE c.serial_number IN ('rychlost-ka1', 'rychlost-kb1');

INSERT INTO dispatches (site_id, zone_id, level_sent, outcome)
SELECT z.site_id, z.id, 1, 'suppressed_disarmed'
FROM zones z, generate_series(1, 3) n
WHERE z.name LIKE 'Zóna %';

INSERT INTO known_plates (site_id, plate) VALUES
  ('00000000-0000-0000-0000-00000000f5a1', '1AB2345'),
  ('00000000-0000-0000-0000-00000000f5b1', '9XY8765'),
  ('00000000-0000-0000-0000-00000000f5b1', '9XY8766');

INSERT INTO audit_log (action) VALUES ('test'), ('test');

SET LOCAL session_replication_role = origin;

-- ── Co by pustila PŮVODNÍ podmínka ─────────────────────────────────
-- Počítá se jako postgres (RLS se neuplatní) s podmínkou ručně, pod
-- identitou daného uživatele — site_is_visible() čte auth.uid()
-- z nastavení, ne z role.

CREATE TEMP TABLE puvodni_podminka (tabulka TEXT, podminka TEXT);
INSERT INTO puvodni_podminka VALUES
  ('detections',         'site_is_visible(site_id)'),
  ('vehicle_passages',   'site_is_visible(site_id)'),
  ('dispatches',         'site_is_visible(site_id)'),
  ('announced_arrivals', 'site_is_visible(site_id)'),
  ('cameras',            'site_is_visible(site_id)'),
  ('zones',              'site_is_visible(site_id)'),
  ('patrols',            'site_is_visible(site_id)'),
  ('known_plates',       'site_is_visible(site_id)'),
  ('camera_recordings',  'site_is_visible(camera_site_id(camera_id))'),
  ('audit_log',          'is_admin()'),
  ('cron_runs',          'is_operator()');

CREATE TEMP TABLE ocekavano (uzivatel TEXT, tabulka TEXT, pocet BIGINT);
GRANT SELECT ON puvodni_podminka, ocekavano TO authenticated;

CREATE FUNCTION pg_temp.spocitat_ocekavane(p_uzivatel TEXT, p_uid UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  n BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::TEXT, true);
  FOR r IN SELECT * FROM puvodni_podminka LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %s', r.tabulka, r.podminka) INTO n;
    INSERT INTO ocekavano VALUES (p_uzivatel, r.tabulka, n);
  END LOOP;
END $$;

SELECT pg_temp.spocitat_ocekavane('admin',      '00000000-0000-0000-0000-00000000f0a1');
SELECT pg_temp.spocitat_ocekavane('operator',   '00000000-0000-0000-0000-00000000f0b1');
SELECT pg_temp.spocitat_ocekavane('klient',     '00000000-0000-0000-0000-00000000f0c1');
SELECT pg_temp.spocitat_ocekavane('bez grantu', '00000000-0000-0000-0000-00000000f0d1');

-- Test, který by prošel i na prázdných tabulkách, nic neříká.
DO $$
BEGIN
  IF (SELECT pocet FROM ocekavano WHERE uzivatel = 'klient' AND tabulka = 'detections')
     NOT BETWEEN 1 AND (SELECT count(*) - 1 FROM detections) THEN
    RAISE EXCEPTION 'FAIL  data testu nerozlišují: klient má vidět část detekcí, ne nic ani všechno';
  END IF;
  IF (SELECT pocet FROM ocekavano WHERE uzivatel = 'klient' AND tabulka = 'camera_recordings')
     NOT BETWEEN 1 AND (SELECT count(*) - 1 FROM camera_recordings) THEN
    RAISE EXCEPTION 'FAIL  data testu nerozlišují u klipů';
  END IF;
  RAISE NOTICE 'ok    data testu rozlišují lokality';
END $$;

-- ── Co vidí přes NOVÉ politiky ─────────────────────────────────────

CREATE FUNCTION pg_temp.porovnat(p_uzivatel TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  n BIGINT;
BEGIN
  FOR r IN SELECT o.tabulka, o.pocet FROM ocekavano o WHERE o.uzivatel = p_uzivatel LOOP
    EXECUTE format('SELECT count(*) FROM %I', r.tabulka) INTO n;
    IF n IS DISTINCT FROM r.pocet THEN
      RAISE EXCEPTION 'FAIL  % vidí v % % řádků, původní podmínka pouštěla %',
        p_uzivatel, r.tabulka, n, r.pocet;
    END IF;
    RAISE NOTICE 'ok    % · % = %', p_uzivatel, r.tabulka, n;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.porovnat(TEXT) TO authenticated;

SET LOCAL ROLE authenticated;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000f0a1","role":"authenticated"}';
SELECT pg_temp.porovnat('admin');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000f0b1","role":"authenticated"}';
SELECT pg_temp.porovnat('operator');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000f0c1","role":"authenticated"}';
SELECT pg_temp.porovnat('klient');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000f0d1","role":"authenticated"}';
SELECT pg_temp.porovnat('bez grantu');

RESET ROLE;

-- ── anon na nové funkce nesmí ──────────────────────────────────────

DO $$
BEGIN
  IF has_function_privilege('anon', 'visible_site_ids()', 'EXECUTE')
     OR has_function_privilege('anon', 'visible_camera_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL  anon smí volat visible_site_ids/visible_camera_ids';
  END IF;
  IF NOT has_function_privilege('authenticated', 'visible_site_ids()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'visible_camera_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL  authenticated nesmí volat funkce z politik — spadl by každý dotaz';
  END IF;
  RAISE NOTICE 'ok    práva na visible_*_ids()';
END $$;

-- ── Politiky se do pomalého tvaru nevrátily ────────────────────────
-- Čtecí politika velké tabulky nesmí volat site_is_visible() ani
-- camera_site_id() nad sloupcem řádku. Kdo ji přepíše, má použít
-- `site_id IN (SELECT visible_site_ids())`.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'SELECT'
      AND tablename IN ('detections', 'vehicle_passages', 'dispatches',
                        'announced_arrivals', 'cameras', 'zones', 'patrols',
                        'known_plates', 'camera_recordings')
  LOOP
    IF r.qual ~ 'site_is_visible\(|camera_site_id\(' THEN
      RAISE EXCEPTION 'FAIL  %.% volá funkci na každý řádek: %',
        r.tablename, r.policyname, r.qual;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok    čtecí politiky velkých tabulek počítají viditelnost jednou';
END $$;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;

ROLLBACK;
