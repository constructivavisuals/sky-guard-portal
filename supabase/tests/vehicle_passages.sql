-- Test evidence vjezdů. Běží v transakci s ROLLBACKem.
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

CREATE FUNCTION public.test_expect_text(label TEXT, actual TEXT, expected TEXT)
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
  WHEN unique_violation THEN RAISE NOTICE 'ok    % — odmítnuto unikátností', label;
  WHEN check_violation THEN RAISE NOTICE 'ok    % — odmítnuto omezením', label;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;

-- ── Normalizace ──────────────────────────────────────────────────

SELECT test_expect_text('mezery a pomlčky pryč, malá písmena nahoru',
  plate_normalize('1ab 2345'), '1AB2345');
SELECT test_expect_text('pomlčka taky', plate_normalize('1AB-2345'), '1AB2345');
SELECT test_expect_text('tečky a lomítka taky', plate_normalize('1.A/B 23_45'), '1AB2345');
SELECT test_expect_text('diakritika není alfanumerická v ASCII smyslu',
  plate_normalize('ČAU 123'), 'AU123');
SELECT test_expect_text('prázdný vstup dá prázdno', plate_normalize('   '), '');

-- ── Data ─────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-00000000ff01'),
  ('00000000-0000-0000-0000-00000000ff02');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-00000000ff01', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-00000000ff02', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-00000000fa01', 'Areál', 'Europe/Prague'),
  ('00000000-0000-0000-0000-00000000fa02', 'Cizí areál', 'Europe/Prague');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-00000000ff02', '00000000-0000-0000-0000-00000000fa01');
INSERT INTO zones (id, site_id, name) VALUES
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000fa01', 'Brána');
INSERT INTO cameras (id, site_id, zone_id, name, serial_number) VALUES
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000fa01',
   '00000000-0000-0000-0000-00000000fb01', 'Brána', 'CAM-BRANA');
INSERT INTO detections (id, site_id, camera_id, zone_id, object_class, source, detected_at) VALUES
  ('00000000-0000-0000-0000-00000000fd01', '00000000-0000-0000-0000-00000000fa01',
   '00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000fb01',
   'vehicle', 'camera', '2026-09-01 22:00:00+02');

-- ── known_plates ─────────────────────────────────────────────────

INSERT INTO known_plates (id, site_id, plate, label, list_type) VALUES
  ('00000000-0000-0000-0000-00000000fa11', '00000000-0000-0000-0000-00000000fa01',
   '1AB 2345', 'Dodávka stavby', 'allow');

SELECT test_expect_rejected('tatáž značka jinak zapsaná neprojde', $sql$
  INSERT INTO known_plates (site_id, plate, list_type)
  VALUES ('00000000-0000-0000-0000-00000000fa01', '1ab-2345', 'deny')
$sql$);

-- Na jiné lokalitě tatáž značka smí být, a klidně na opačném seznamu.
INSERT INTO known_plates (site_id, plate, list_type) VALUES
  ('00000000-0000-0000-0000-00000000fa02', '1AB2345', 'deny');
SELECT test_expect('táž značka na dvou lokalitách je v pořádku',
  (SELECT count(*) FROM known_plates WHERE plate_normalize(plate) = '1AB2345'), 2);

SELECT test_expect_rejected('prázdná značka neprojde', $sql$
  INSERT INTO known_plates (site_id, plate)
  VALUES ('00000000-0000-0000-0000-00000000fa01', '   ')
$sql$);

-- ── vehicle_passages ─────────────────────────────────────────────

INSERT INTO vehicle_passages (
  id, site_id, camera_id, detection_id, plate, confidence,
  image_path, list_match, known_plate_id, known_label, plate_read_at, passed_at
) VALUES (
  '00000000-0000-0000-0000-00000000fbb1',
  '00000000-0000-0000-0000-00000000fa01',
  '00000000-0000-0000-0000-00000000fc01',
  '00000000-0000-0000-0000-00000000fd01',
  '1AB2345', 0.94,
  '00000000-0000-0000-0000-00000000fa01/fp01.jpg',
  'allow', '00000000-0000-0000-0000-00000000fa11', 'Dodávka stavby',
  '2026-09-01 22:00:05+02', '2026-09-01 22:00:00+02'
);

SELECT test_expect_rejected('druhý vjezd k téže detekci neprojde', $sql$
  INSERT INTO vehicle_passages (site_id, detection_id)
  VALUES ('00000000-0000-0000-0000-00000000fa01',
          '00000000-0000-0000-0000-00000000fd01')
$sql$);

SELECT test_expect_rejected('do image_path nejde uložit URL', $sql$
  UPDATE vehicle_passages SET image_path = 'https://example.com/a.jpg'
   WHERE id = '00000000-0000-0000-0000-00000000fbb1'
$sql$);

SELECT test_expect_rejected('shoda bez značky neprojde', $sql$
  UPDATE vehicle_passages SET plate = NULL
   WHERE id = '00000000-0000-0000-0000-00000000fbb1'
$sql$);

SELECT test_expect_rejected('jistota nad jedničku neprojde', $sql$
  UPDATE vehicle_passages SET confidence = 1.5
   WHERE id = '00000000-0000-0000-0000-00000000fbb1'
$sql$);

-- Vjezd bez přečtené značky je regulérní stav.
INSERT INTO detections (id, site_id, camera_id, zone_id, object_class, source, detected_at) VALUES
  ('00000000-0000-0000-0000-00000000fd02', '00000000-0000-0000-0000-00000000fa01',
   '00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000fb01',
   'vehicle', 'camera', '2026-09-01 22:05:00+02');
INSERT INTO vehicle_passages (site_id, camera_id, detection_id, passed_at) VALUES
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fc01',
   '00000000-0000-0000-0000-00000000fd02', '2026-09-01 22:05:00+02');

SELECT test_expect('vjezd bez značky projde',
  (SELECT count(*) FROM vehicle_passages WHERE plate IS NULL), 1);

-- Smazání detekce vezme vjezd s sebou — bez ní by neměl na čem viset.
DELETE FROM detections WHERE id = '00000000-0000-0000-0000-00000000fd02';
SELECT test_expect('smazaná detekce vzala vjezd s sebou',
  (SELECT count(*) FROM vehicle_passages), 1);

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ff02"}';

SELECT test_expect('klient s grantem vidí vjezd na své lokalitě',
  (SELECT count(*) FROM vehicle_passages), 1);
SELECT test_expect('a vidí jen značky své lokality',
  (SELECT count(*) FROM known_plates), 1);

-- Vjezdy nesmí zakládat ani měnit nikdo z portálu — je to důkaz.
DELETE FROM vehicle_passages;
SELECT test_expect('klient vjezd nesmaže', (SELECT count(*) FROM vehicle_passages), 1);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ff01"}';

DELETE FROM vehicle_passages;
SELECT test_expect('ani admin vjezd nesmaže',
  (SELECT count(*) FROM vehicle_passages), 1);

-- Značky spravuje admin, klient ne.
INSERT INTO known_plates (site_id, plate, list_type)
VALUES ('00000000-0000-0000-0000-00000000fa01', '5XY 9999', 'deny');
SELECT test_expect('admin značku přidá', (SELECT count(*) FROM known_plates), 3);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ff02"}';

-- Přidat allow značku znamená vypnout ostrahu pro jedno auto; klientovi
-- to nepatří, i když seznam vidí.
DO $$
BEGIN
  INSERT INTO known_plates (site_id, plate, list_type)
  VALUES ('00000000-0000-0000-0000-00000000fa01', '9ZZ 0000', 'allow');
  RAISE EXCEPTION 'FAIL  klient značku přidal, ačkoli neměl';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient značku nepřidá — odmítnuto politikou';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
