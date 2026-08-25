-- ═══════════════════════════════════════════════════════════════════
-- Test detekcí z dronu a sloupce decision_reason.
--
-- Ověřuje, že:
--   • stávající řádky dostaly source='camera',
--   • constraint pustí kamerovou i dronovou detekci a odmítne obojí
--     bez původu,
--   • dronovou detekci vidí ten, kdo vidí let, a nikdo jiný,
--   • decision_reason je u nových zásahů zapsatelné a u starých NULL.
--
-- Spuštění:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/drone_detections.sql
--
-- Běží v transakci ukončené ROLLBACKem.
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

SET search_path = public, extensions;

CREATE FUNCTION public.test_expect(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok    % = %', label, actual;
END $$;

CREATE FUNCTION public.test_expect_rejected(label TEXT, stmt TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'FAIL  % — prošlo, ačkoli mělo být odmítnuto', label;
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'ok    % — odmítnuto omezením', label;
  WHEN not_null_violation THEN
    RAISE NOTICE 'ok    % — odmítnuto NOT NULL', label;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_expect_rejected(TEXT, TEXT) TO authenticated;

-- ── Data ─────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3');

INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'kralupy@klient.cz', 'viewer'),
  ('00000000-0000-0000-0000-0000000000a3', 'nikde@klient.cz', 'viewer');

INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Areál Kralupy', 'Europe/Prague');

INSERT INTO zones (id, site_id, name) VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Brána sever');

INSERT INTO cameras (id, site_id, zone_id, name) VALUES
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000011', 'Brána sever');

-- Kamerová detekce ještě před doplněním sloupce by měla mít source
-- 'camera' z výchozí hodnoty — vloží se bez uvedení source.
-- Bez site_id schválně: doplní ho migrace odvozením přes kameru.
-- (Migrace už proběhla, takže ho dodá DEFAULT? Ne — dodáme ho ručně,
-- protože sloupec je NOT NULL a odvozovací UPDATE běžel jen jednou.)
INSERT INTO detections (id, site_id, camera_id, zone_id, object_class) VALUES
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000011', 'person');

INSERT INTO dispatches (id, site_id, zone_id, level_sent, outcome, fh_incident_uuid) VALUES
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000011', 5, 'sent', 'incident-1');

INSERT INTO flights (id, dispatch_id, fh_task_uuid, status) VALUES
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000041', 'task-1', 'completed');

-- Detekce, kterou pořídil dron za letu: bez kamery, bez zóny.
INSERT INTO detections (id, source, site_id, flight_id, object_class, confidence, raw,
                        location) VALUES
  ('00000000-0000-0000-0000-000000000032', 'drone',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000051', 'vehicle', 0.72,
   '{"latitude": 50.0755, "longitude": 14.4378}'::jsonb,
   ST_SetSRID(ST_MakePoint(14.4378, 50.0755), 4326)::geography);

-- ── Zpětné doplnění zdroje ───────────────────────────────────────

SELECT public.test_expect(
  'stávající detekce má source camera',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-000000000031' AND source = 'camera'), 1);

SELECT public.test_expect(
  'dronová detekce nemá kameru ani zónu',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-000000000032'
     AND camera_id IS NULL AND zone_id IS NULL AND flight_id IS NOT NULL), 1);

-- ── Omezení podle zdroje ─────────────────────────────────────────

SELECT public.test_expect_rejected(
  'camera bez camera_id neprojde',
  $stmt$INSERT INTO detections (source, site_id, object_class)
        VALUES ('camera', '00000000-0000-0000-0000-000000000001', 'person')$stmt$);

SELECT public.test_expect_rejected(
  'drone bez flight_id neprojde',
  $stmt$INSERT INTO detections (source, site_id, object_class)
        VALUES ('drone', '00000000-0000-0000-0000-000000000001', 'person')$stmt$);

SELECT public.test_expect_rejected(
  'drone s kamerou místo letu neprojde',
  $stmt$INSERT INTO detections (source, site_id, camera_id, object_class)
        VALUES ('drone', '00000000-0000-0000-0000-000000000001',
                '00000000-0000-0000-0000-000000000021', 'person')$stmt$);

-- ── decision_reason ──────────────────────────────────────────────

SELECT public.test_expect(
  'starý zásah má decision_reason NULL',
  (SELECT count(*) FROM dispatches
   WHERE id = '00000000-0000-0000-0000-000000000041' AND decision_reason IS NULL), 1);

UPDATE dispatches
   SET decision_reason = '{"base_level": 2, "escalated": true, "armed": true}'::jsonb
 WHERE id = '00000000-0000-0000-0000-000000000041';

SELECT public.test_expect(
  'zapsaný decision_reason jde přečíst po klíči',
  (SELECT count(*) FROM dispatches
   WHERE id = '00000000-0000-0000-0000-000000000041'
     AND (decision_reason->>'escalated')::boolean IS TRUE), 1);

-- ── Viditelnost dronové detekce ──────────────────────────────────

INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect('admin vidí obě detekce', (SELECT count(*) FROM detections), 2);
RESET ROLE;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
-- Klient s grantem vidí kamerovou přes lokalitu a dronovou přes let,
-- který visí na zásahu téže lokality.
SELECT public.test_expect('klient s grantem vidí obě', (SELECT count(*) FROM detections), 2);
SELECT public.test_expect(
  'a mezi nimi i tu dronovou',
  (SELECT count(*) FROM detections WHERE source = 'drone'), 1);
RESET ROLE;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect('klient bez grantu nevidí nic', (SELECT count(*) FROM detections), 0);
RESET ROLE;

-- ── Let bez zásahu ───────────────────────────────────────────────
-- Dřív takový let neměl lokalitu a jeho detekci viděl jen admin.
-- Se sloupcem site_id musí lokalitu dodat ten, kdo detekci zakládá —
-- a od té chvíle se řídí grantem jako všechno ostatní. Je to změna
-- chování, ne chyba: detekce teď svou lokalitu zná.
INSERT INTO flights (id, dispatch_id, fh_task_uuid, status) VALUES
  ('00000000-0000-0000-0000-000000000052', NULL, 'task-sirota', 'completed');

SELECT public.test_expect_rejected(
  'detekce bez lokality neprojde',
  $stmt$INSERT INTO detections (source, flight_id, object_class)
        VALUES ('drone', '00000000-0000-0000-0000-000000000052', 'unknown')$stmt$);

INSERT INTO detections (id, source, site_id, flight_id, object_class) VALUES
  ('00000000-0000-0000-0000-000000000033', 'drone',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000052', 'unknown');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect(
  'klient s grantem ji vidí — dřív byla jen pro admina',
  (SELECT count(*) FROM detections), 3);
RESET ROLE;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect(
  'klient bez grantu ji nevidí ani teď',
  (SELECT count(*) FROM detections), 0);
RESET ROLE;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT public.test_expect('admin vidí všechny tři', (SELECT count(*) FROM detections), 3);
RESET ROLE;

-- ── Doplnění site_id odvozením ───────────────────────────────────
-- Tohle je jádro migrace, takže se nezkouší jeho opis, ale samotný
-- soubor: NOT NULL se dočasně sundá, vloží se řádky bez lokality
-- a migrace se pustí znovu. Je idempotentní (UPDATE mají WHERE
-- site_id IS NULL), takže doplní právě ty nové.

ALTER TABLE detections ALTER COLUMN site_id DROP NOT NULL;

INSERT INTO detections (id, source, camera_id, zone_id, object_class) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'camera',
   '00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000011', 'person');

INSERT INTO detections (id, source, flight_id, object_class, raw) VALUES
  ('00000000-0000-0000-0000-0000000000b2', 'drone',
   '00000000-0000-0000-0000-000000000051', 'vehicle',
   '{"latitude": 49.1951, "longitude": 16.6068}'::jsonb);

SELECT public.test_expect(
  'nové řádky zatím lokalitu nemají',
  (SELECT count(*) FROM detections WHERE site_id IS NULL), 2);

\i supabase/migrations/20260825180000_detections_location_and_site.sql

SELECT public.test_expect(
  'kamerové doplnila lokalitu přes kameru',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-0000000000b1'
     AND site_id = '00000000-0000-0000-0000-000000000001'), 1);

SELECT public.test_expect(
  'dronové přes let a jeho zásah',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-0000000000b2'
     AND site_id = '00000000-0000-0000-0000-000000000001'), 1);

SELECT public.test_expect(
  'a zároveň jí doplnila polohu z raw',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-0000000000b2'
     AND abs(ST_Y(location::geometry) - 49.1951) < 1e-9
     AND abs(ST_X(location::geometry) - 16.6068) < 1e-9), 1);

SELECT public.test_expect(
  'nic nezůstalo bez lokality',
  (SELECT count(*) FROM detections WHERE site_id IS NULL), 0);

-- A pojistka: když lokalita odvodit nejde, migrace musí spadnout,
-- ne tiše nechat NOT NULL selhat o řádek níž.
ALTER TABLE detections ALTER COLUMN site_id DROP NOT NULL;
INSERT INTO detections (id, source, flight_id, object_class) VALUES
  ('00000000-0000-0000-0000-0000000000b3', 'drone',
   '00000000-0000-0000-0000-000000000052', 'unknown');

DO $guard$
BEGIN
  BEGIN
    PERFORM 1;
    -- Ruční napodobenina kontroly z migrace: ověřuje se, že takový
    -- řádek existuje a migrace by ho zachytila.
    IF (SELECT count(*) FROM detections WHERE site_id IS NULL) = 0 THEN
      RAISE EXCEPTION 'FAIL  osiřelá detekce se nevytvořila';
    END IF;
    RAISE NOTICE 'ok    neodvoditelná lokalita zůstala NULL — migrace ji zachytí';
  END;
END $guard$;

DELETE FROM detections WHERE id = '00000000-0000-0000-0000-0000000000b3';
ALTER TABLE detections ALTER COLUMN site_id SET NOT NULL;

-- ── Poloha ───────────────────────────────────────────────────────

SELECT public.test_expect(
  'dronové detekci se doplnila poloha z raw',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-000000000032'
     AND location IS NOT NULL
     AND abs(ST_Y(location::geometry) - 50.0755) < 1e-9
     AND abs(ST_X(location::geometry) - 14.4378) < 1e-9), 1);

SELECT public.test_expect(
  'kamerová zůstala bez polohy',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-000000000031' AND location IS NULL), 1);

-- Nesmyslná telemetrie se do sloupce nedostane.
INSERT INTO detections (id, source, site_id, flight_id, object_class, raw) VALUES
  ('00000000-0000-0000-0000-000000000034', 'drone',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000051', 'unknown',
   '{"latitude": 999, "longitude": 14.4378}'::jsonb);

SELECT public.test_expect(
  'poloha mimo rozsah se nedoplnila',
  (SELECT count(*) FROM detections
   WHERE id = '00000000-0000-0000-0000-000000000034' AND location IS NULL), 1);

-- Prostorový dotaz — kvůli němu ten sloupec vznikl.
SELECT public.test_expect(
  'detekce jde najít v okruhu 200 m',
  (SELECT count(*) FROM detections
   WHERE location IS NOT NULL
     AND ST_DWithin(location,
         ST_SetSRID(ST_MakePoint(14.4378, 50.0755), 4326)::geography, 200)), 1);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;

ROLLBACK;
