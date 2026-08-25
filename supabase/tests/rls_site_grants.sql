-- ═══════════════════════════════════════════════════════════════════
-- Test rozsahu viditelnosti po zavedení site_grants.
--
-- Ověřuje, že přepsání jediné funkce site_is_visible() zúžilo rozsah
-- ve všech navázaných politikách:
--   admin              vidí obě lokality a všechno pod nimi,
--   klient s grantem   jen svou lokalitu,
--   klient bez grantu  nic.
--
-- Spuštění (psql proti nasazené databázi nebo lokální kopii):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_site_grants.sql
--
-- Celé to běží v transakci ukončené ROLLBACKem — testovací data
-- v databázi nezůstanou. Vyžaduje roli, která smí SET ROLE na
-- authenticated (postgres / supabase_admin).
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public, extensions;

-- ── Pomocníci pro tvrzení ───────────────────────────────────────
-- Schválně v public, ne v pg_temp: na dočasné schéma nemusí mít
-- přepnutá role authenticated právo USAGE a testy by padaly na tom
-- místo na politikách. Transakce se stejně vrací zpět.

CREATE FUNCTION public.test_expect(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok    % = %', label, actual;
END $$;

/** Zápis, který má RLS odmítnout chybou (INSERT proti WITH CHECK). */
CREATE FUNCTION public.test_expect_denied(label TEXT, stmt TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'FAIL  % — příkaz prošel, ačkoli měl být odmítnut', label;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    % — odmítnuto chybou', label;
END $$;

/**
 * Příkaz, který RLS neodmítne chybou, ale nesmí nic změnit.
 *
 * DELETE ani UPDATE proti USING klauzuli chybu nevyhodí — prostě
 * nenajdou žádný řádek. Tvrzení „selže“ by tu bylo falešně zelené,
 * proto se měří počet dotčených řádků.
 */
CREATE FUNCTION public.test_expect_no_effect(label TEXT, stmt TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE affected BIGINT;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'FAIL  % — dotčeno % řádků, čekáno 0', label, affected;
  END IF;
  RAISE NOTICE 'ok    % — beze změny', label;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    % — odmítnuto chybou', label;
END $$;

-- Nové funkce mají EXECUTE pro PUBLIC už z výchozího nastavení, ale
-- explicitně to nezávisí na tom, jak má projekt nastavená default
-- privileges.
GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_expect_denied(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_expect_no_effect(TEXT, TEXT) TO authenticated;

-- ── Testovací data ───────────────────────────────────────────────
-- Zakládá se pod původní rolí (bez RLS), aby šlo připravit i to,
-- na co testovaní uživatelé nedosáhnou.

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),  -- admin
  ('00000000-0000-0000-0000-0000000000a2'),  -- klient s grantem
  ('00000000-0000-0000-0000-0000000000a3');  -- klient bez grantu

INSERT INTO profiles (id, email, full_name, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'admin@sky-guard.cz',  'Admin',   'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'kralupy@klient.cz',   'Klient A', 'viewer'),
  ('00000000-0000-0000-0000-0000000000a3', 'nikde@klient.cz',     'Klient B', 'viewer');

INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Areál Kralupy',  'Europe/Prague'),
  ('00000000-0000-0000-0000-000000000002', 'Sklad Brno-jih', 'Europe/Prague');

INSERT INTO zones (id, site_id, name, location) VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
   'Brána sever', ST_SetSRID(ST_MakePoint(14.4378, 50.0755), 4326)::geography),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002',
   'Vjezd', ST_SetSRID(ST_MakePoint(16.6068, 49.1951), 4326)::geography);

INSERT INTO cameras (id, site_id, zone_id, name, serial_number) VALUES
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000011', 'Brána sever', 'CAM-1'),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000012', 'Vjezd', 'CAM-2');

-- site_id je od migrace 20260825180000 povinné.
INSERT INTO detections (id, site_id, camera_id, zone_id, object_class, confidence) VALUES
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000011', 'person', 0.9),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000022',
   '00000000-0000-0000-0000-000000000012', 'vehicle', 0.5);

INSERT INTO dispatches (id, site_id, zone_id, level_sent, outcome, fh_incident_uuid) VALUES
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000011', 5, 'sent', 'incident-1'),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000012', 2, 'sent', 'incident-2');

-- Třetí let je bez dispatche (ruční mise) — nemá lokalitu, takže na něj
-- podle flight_is_visible() dosáhne jen admin.
INSERT INTO flights (id, dispatch_id, fh_task_id, status) VALUES
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000041', 'task-1', 'completed'),
  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-000000000042', 'task-2', 'completed'),
  ('00000000-0000-0000-0000-000000000053', NULL, 'task-3', 'completed');

INSERT INTO media (flight_id, kind, r2_key) VALUES
  ('00000000-0000-0000-0000-000000000051', 'photo', 'r2/f1.jpg'),
  ('00000000-0000-0000-0000-000000000052', 'photo', 'r2/f2.jpg'),
  ('00000000-0000-0000-0000-000000000053', 'photo', 'r2/f3.jpg');

-- Klient A dostane přístup jen na Kralupy.
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001');

-- ── Admin: vidí všechno ──────────────────────────────────────────

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT public.test_expect('admin: sites',       (SELECT count(*) FROM sites), 2);
SELECT public.test_expect('admin: zones',       (SELECT count(*) FROM zones), 2);
SELECT public.test_expect('admin: cameras',     (SELECT count(*) FROM cameras), 2);
SELECT public.test_expect('admin: detections',  (SELECT count(*) FROM detections), 2);
SELECT public.test_expect('admin: dispatches',  (SELECT count(*) FROM dispatches), 2);
SELECT public.test_expect('admin: flights',     (SELECT count(*) FROM flights), 3);
SELECT public.test_expect('admin: media',       (SELECT count(*) FROM media), 3);
SELECT public.test_expect('admin: site_grants', (SELECT count(*) FROM site_grants), 1);
SELECT public.test_expect('admin: profiles',    (SELECT count(*) FROM profiles), 3);

RESET ROLE;

-- ── Klient s grantem: jen svoje ──────────────────────────────────

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT public.test_expect('klient s grantem: sites',       (SELECT count(*) FROM sites), 1);
SELECT public.test_expect('klient s grantem: zones',       (SELECT count(*) FROM zones), 1);
SELECT public.test_expect('klient s grantem: cameras',     (SELECT count(*) FROM cameras), 1);
SELECT public.test_expect('klient s grantem: detections',  (SELECT count(*) FROM detections), 1);
SELECT public.test_expect('klient s grantem: dispatches',  (SELECT count(*) FROM dispatches), 1);
-- Let bez dispatche se do počtu nepromítne — nemá lokalitu.
SELECT public.test_expect('klient s grantem: flights',     (SELECT count(*) FROM flights), 1);
SELECT public.test_expect('klient s grantem: media',       (SELECT count(*) FROM media), 1);
SELECT public.test_expect('klient s grantem: site_grants', (SELECT count(*) FROM site_grants), 1);
-- Cizí profily nevidí, jen svůj.
SELECT public.test_expect('klient s grantem: profiles',    (SELECT count(*) FROM profiles), 1);
SELECT public.test_expect('klient s grantem: audit_log',   (SELECT count(*) FROM audit_log), 0);

-- A že vidí opravdu tu SVOU lokalitu, ne prostě nějakou jednu.
SELECT public.test_expect(
  'klient s grantem: vidí Kralupy',
  (SELECT count(*) FROM sites WHERE name = 'Areál Kralupy'), 1);
SELECT public.test_expect(
  'klient s grantem: nevidí Brno',
  (SELECT count(*) FROM sites WHERE name = 'Sklad Brno-jih'), 0);

-- Přístup si sám rozšířit nesmí.
SELECT public.test_expect_denied(
  'klient s grantem: nesmí si přidat grant',
  $stmt$INSERT INTO site_grants (profile_id, site_id)
        VALUES ('00000000-0000-0000-0000-0000000000a2',
                '00000000-0000-0000-0000-000000000002')$stmt$);

SELECT public.test_expect_no_effect(
  'klient s grantem: nesmí smazat svůj grant',
  $stmt$DELETE FROM site_grants
        WHERE profile_id = '00000000-0000-0000-0000-0000000000a2'$stmt$);

RESET ROLE;

-- ── Klient bez grantu: nic ───────────────────────────────────────

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT public.test_expect('klient bez grantu: sites',       (SELECT count(*) FROM sites), 0);
SELECT public.test_expect('klient bez grantu: zones',       (SELECT count(*) FROM zones), 0);
SELECT public.test_expect('klient bez grantu: cameras',     (SELECT count(*) FROM cameras), 0);
SELECT public.test_expect('klient bez grantu: detections',  (SELECT count(*) FROM detections), 0);
SELECT public.test_expect('klient bez grantu: dispatches',  (SELECT count(*) FROM dispatches), 0);
SELECT public.test_expect('klient bez grantu: flights',     (SELECT count(*) FROM flights), 0);
SELECT public.test_expect('klient bez grantu: media',       (SELECT count(*) FROM media), 0);
SELECT public.test_expect('klient bez grantu: site_grants', (SELECT count(*) FROM site_grants), 0);
SELECT public.test_expect('klient bez grantu: audit_log',   (SELECT count(*) FROM audit_log), 0);
-- Svůj vlastní profil vidí pořád — není vázaný na lokalitu.
SELECT public.test_expect('klient bez grantu: vlastní profil', (SELECT count(*) FROM profiles), 1);

RESET ROLE;

-- ── Odebrání grantu přístup zavře ────────────────────────────────

DELETE FROM site_grants WHERE profile_id = '00000000-0000-0000-0000-0000000000a2';

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT public.test_expect('po odebrání grantu: sites',      (SELECT count(*) FROM sites), 0);
SELECT public.test_expect('po odebrání grantu: detections', (SELECT count(*) FROM detections), 0);

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;

ROLLBACK;
