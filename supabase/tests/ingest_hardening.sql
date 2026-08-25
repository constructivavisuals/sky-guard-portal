-- Test zpevnění ingestu. Běží v transakci s ROLLBACKem.
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

CREATE FUNCTION public.test_expect_bool(label TEXT, actual BOOLEAN, expected BOOLEAN)
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
  WHEN insufficient_privilege THEN RAISE NOTICE 'ok    % — odmítnuto právy', label;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-000000000ec1'),
  ('00000000-0000-0000-0000-000000000ec2');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-000000000ec1', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-000000000ec2', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-000000000ea1', 'Areál', 'Europe/Prague');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-000000000ec2', '00000000-0000-0000-0000-000000000ea1');
INSERT INTO cameras (id, site_id, name, serial_number) VALUES
  ('00000000-0000-0000-0000-000000000eb1', '00000000-0000-0000-0000-000000000ea1',
   'Brána', 'CAM-T-01');

-- Existenci indexu netestujeme, jen chování — jméno může být zabrané
-- jiným indexem a CREATE ... IF NOT EXISTS to tiše přejde.

-- ── 1D: ochrana proti přehrání ───────────────────────────────────

INSERT INTO detections (site_id, camera_id, detected_at, object_class, source)
VALUES ('00000000-0000-0000-0000-000000000ea1',
        '00000000-0000-0000-0000-000000000eb1',
        '2026-08-31 22:00:00+02', 'person', 'camera');

SELECT test_expect_rejected('tatáž detekce podruhé neprojde', $sql$
  INSERT INTO detections (site_id, camera_id, detected_at, object_class, source)
  VALUES ('00000000-0000-0000-0000-000000000ea1',
          '00000000-0000-0000-0000-000000000eb1',
          '2026-08-31 22:00:00+02', 'person', 'camera')
$sql$);

-- O mikrosekundu jinam je to jiná detekce, ne přehrání.
INSERT INTO detections (site_id, camera_id, detected_at, object_class, source)
VALUES ('00000000-0000-0000-0000-000000000ea1',
        '00000000-0000-0000-0000-000000000eb1',
        '2026-08-31 22:00:00.000001+02', 'person', 'camera');

SELECT test_expect('o mikrosekundu jinam projde',
  (SELECT count(*) FROM detections
    WHERE camera_id = '00000000-0000-0000-0000-000000000eb1'), 2);

-- Detekce z dronu kameru nemají; unikát se jich nesmí týkat.
-- Let musí existovat, jinak je odmítne detections_source_requires_origin.
INSERT INTO flights (id, site_id, kind, status)
VALUES ('00000000-0000-0000-0000-000000000ed1',
        '00000000-0000-0000-0000-000000000ea1', 'dispatch', 'pending');

INSERT INTO detections (site_id, camera_id, detected_at, object_class, source, flight_id)
VALUES ('00000000-0000-0000-0000-000000000ea1', NULL,
        '2026-08-31 22:00:00+02', 'person', 'drone',
        '00000000-0000-0000-0000-000000000ed1');
INSERT INTO detections (site_id, camera_id, detected_at, object_class, source, flight_id)
VALUES ('00000000-0000-0000-0000-000000000ea1', NULL,
        '2026-08-31 22:00:00+02', 'vehicle', 'drone',
        '00000000-0000-0000-0000-000000000ed1');

SELECT test_expect('dronové detekce ve stejný čas projdou obě',
  (SELECT count(*) FROM detections WHERE camera_id IS NULL), 2);

-- ── 1E: stopa po odesílateli ─────────────────────────────────────

UPDATE detections
   SET source_ip = '203.0.113.7'::INET, ingest_key_id = 'CAM-T-01'
 WHERE camera_id = '00000000-0000-0000-0000-000000000eb1'
   AND detected_at = '2026-08-31 22:00:00+02';

SELECT test_expect('IP i klíč se uloží',
  (SELECT count(*) FROM detections
    WHERE source_ip = '203.0.113.7'::INET AND ingest_key_id = 'CAM-T-01'), 1);

-- ── 4C: detekce se nesmí mazat ───────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000ec1"}';

-- RLS bez politiky pro DELETE nesmaže nic a chybu nevyhodí, proto se
-- kontroluje počet, ne výjimka.
DELETE FROM detections;
SELECT test_expect('admin nesmaže ani jednu detekci',
  (SELECT count(*) FROM detections), 4);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000ec2"}';
DELETE FROM detections;
SELECT test_expect('klient nesmaže ani jednu detekci',
  (SELECT count(*) FROM detections), 4);

RESET ROLE;

-- Zápis a úprava adminovi zůstávají; klient je nemá a mít nemá.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000ec1"}';
INSERT INTO detections (site_id, camera_id, detected_at, object_class, source, flight_id)
VALUES ('00000000-0000-0000-0000-000000000ea1', NULL,
        '2026-08-31 23:00:00+02', 'person', 'drone',
        '00000000-0000-0000-0000-000000000ed1');
RESET ROLE;

SELECT test_expect('zápis dál projde', (SELECT count(*) FROM detections), 5);

-- ── 1C: vědro s žetony ───────────────────────────────────────────

SELECT test_expect_bool('první požadavek projde',
  ingest_take_tokens(ARRAY['cam:A', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:00+02'::TIMESTAMPTZ), TRUE);
SELECT test_expect_bool('druhý projde',
  ingest_take_tokens(ARRAY['cam:A', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:00+02'::TIMESTAMPTZ), TRUE);
SELECT test_expect_bool('třetí projde',
  ingest_take_tokens(ARRAY['cam:A', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:00+02'::TIMESTAMPTZ), TRUE);
SELECT test_expect_bool('čtvrtý už ne',
  ingest_take_tokens(ARRAY['cam:A', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:00+02'::TIMESTAMPTZ), FALSE);

-- Po čase se vědro doplní: 0,1 žetonu za sekundu → za 20 s dva.
SELECT test_expect_bool('po dvaceti sekundách zase projde',
  ingest_take_tokens(ARRAY['cam:A', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:20+02'::TIMESTAMPTZ), TRUE);

-- Jiná kamera má vlastní vědro, ale sdílí vědro IP adresy.
SELECT test_expect_bool('jiná kamera z téže IP projde',
  ingest_take_tokens(ARRAY['cam:B', 'ip:1.2.3.4'], 3, 0.1,
                     '2026-08-31 22:00:20+02'::TIMESTAMPTZ), TRUE);

-- Vyčerpání IP zastaví i kameru, která má vlastní žetony — jinak by
-- stačilo střídat vymyšlená sériová čísla.
SELECT ingest_take_tokens(ARRAY['ip:9.9.9.9'], 2, 0, '2026-08-31 22:00:00+02'::TIMESTAMPTZ);
SELECT ingest_take_tokens(ARRAY['ip:9.9.9.9'], 2, 0, '2026-08-31 22:00:00+02'::TIMESTAMPTZ);
SELECT test_expect_bool('vyčerpaná IP zastaví i čerstvou kameru',
  ingest_take_tokens(ARRAY['cam:NOVA', 'ip:9.9.9.9'], 2, 0,
                     '2026-08-31 22:00:00+02'::TIMESTAMPTZ), FALSE);

-- Odmítnutý požadavek nesmí ubrat žeton vědru, které ještě mělo.
SELECT test_expect('čerstvé kameře zůstal plný stav',
  (SELECT round(tokens)::BIGINT FROM ingest_rate_limits WHERE key = 'cam:NOVA'), 2);

-- ── Práva na funkci ──────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SELECT test_expect_rejected('přihlášený vědro nevyprázdní', $sql$
  SELECT ingest_take_tokens(ARRAY['cam:A'], 3, 0.1)
$sql$);
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
