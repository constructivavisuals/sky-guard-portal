-- Test dopravců a avizovaných příjezdů.
-- Běží v transakci s ROLLBACKem.
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
  WHEN unique_violation THEN RAISE NOTICE 'ok    % — odmítnuto unikátností', label;
  WHEN check_violation THEN RAISE NOTICE 'ok    % — odmítnuto omezením', label;
END $$;

-- ── Data ─────────────────────────────────────────────────────────

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000d0001'),
  ('00000000-0000-0000-0000-0000000d0002');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000d0001', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000d0002', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'Areál', 'Europe/Prague'),
  ('00000000-0000-0000-0000-0000000e0002', 'Cizí areál', 'Europe/Prague');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000e0001');

INSERT INTO carriers (id, site_id, name, token, created_by) VALUES
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000e0001',
   'Beton Novák', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '00000000-0000-0000-0000-0000000d0001'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-0000000e0002',
   'Cizí dopravce', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NULL);

SELECT test_expect('dopravci založeni', (SELECT count(*) FROM carriers), 2);

-- Token je unikátní: dva dopravci na jeden odkaz nedávají smysl.
SELECT test_expect_rejected('druhý dopravce se stejným tokenem neprojde', $sql$
  INSERT INTO carriers (site_id, name, token)
  VALUES ('00000000-0000-0000-0000-0000000e0001', 'Podvod',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
$sql$);

-- Krátký token by šel uhodnout.
SELECT test_expect_rejected('krátký token neprojde', $sql$
  INSERT INTO carriers (site_id, name, token)
  VALUES ('00000000-0000-0000-0000-0000000e0001', 'Krátký', 'abc')
$sql$);

-- ── Ohlášení ─────────────────────────────────────────────────────

INSERT INTO announced_arrivals (id, carrier_id, site_id, plate, arrival_date, night_ok)
VALUES
  ('00000000-0000-0000-0000-000000110001', '00000000-0000-0000-0000-0000000f0001',
   '00000000-0000-0000-0000-0000000e0001', '1AB 2345', CURRENT_DATE, FALSE),
  ('00000000-0000-0000-0000-000000110002', '00000000-0000-0000-0000-0000000f0001',
   '00000000-0000-0000-0000-0000000e0001', '9ZZ-0000', CURRENT_DATE + 1, TRUE);

SELECT test_expect('night_ok je ve výchozím stavu vypnuté',
  (SELECT count(*) FROM announced_arrivals WHERE night_ok = FALSE), 1);

-- Tentýž dopravce nemá proč hlásit tutéž značku na tentýž den dvakrát,
-- ani jinak zapsanou.
SELECT test_expect_rejected('tatáž značka jinak zapsaná na tentýž den neprojde', $sql$
  INSERT INTO announced_arrivals (carrier_id, site_id, plate, arrival_date)
  VALUES ('00000000-0000-0000-0000-0000000f0001',
          '00000000-0000-0000-0000-0000000e0001', '1ab2345', CURRENT_DATE)
$sql$);

-- Po zrušení jde ohlásit znovu — člověk si to může rozmyslet.
UPDATE announced_arrivals SET cancelled_at = now()
WHERE id = '00000000-0000-0000-0000-000000110001';

INSERT INTO announced_arrivals (carrier_id, site_id, plate, arrival_date)
VALUES ('00000000-0000-0000-0000-0000000f0001',
        '00000000-0000-0000-0000-0000000e0001', '1AB2345', CURRENT_DATE);

SELECT test_expect('po zrušení jde ohlásit znovu',
  (SELECT count(*) FROM announced_arrivals
   WHERE plate_normalize(plate) = '1AB2345' AND cancelled_at IS NULL), 1);

-- Dotaz ingestu: dnešek, nezrušené, normalizovaná shoda.
SELECT test_expect('ingest najde dnešní ohlášení',
  (SELECT count(*) FROM announced_arrivals
   WHERE site_id = '00000000-0000-0000-0000-0000000e0001'
     AND arrival_date = CURRENT_DATE
     AND cancelled_at IS NULL
     AND plate_normalize(plate) = plate_normalize('1ab 2345')), 1);

-- ── Vazba na vjezd ───────────────────────────────────────────────

INSERT INTO zones (id, site_id, name) VALUES
  ('00000000-0000-0000-0000-000000120001', '00000000-0000-0000-0000-0000000e0001', 'Brána');
INSERT INTO cameras (id, site_id, zone_id, name, serial_number) VALUES
  ('00000000-0000-0000-0000-000000130001', '00000000-0000-0000-0000-0000000e0001',
   '00000000-0000-0000-0000-000000120001', 'Brána', 'CAM-1');
INSERT INTO detections (id, source, site_id, camera_id, zone_id, object_class)
VALUES ('00000000-0000-0000-0000-000000140001', 'camera',
        '00000000-0000-0000-0000-0000000e0001',
        '00000000-0000-0000-0000-000000130001',
        '00000000-0000-0000-0000-000000120001', 'vehicle');

INSERT INTO vehicle_passages (site_id, camera_id, detection_id, announced_arrival_id)
VALUES ('00000000-0000-0000-0000-0000000e0001',
        '00000000-0000-0000-0000-000000130001',
        '00000000-0000-0000-0000-000000140001',
        '00000000-0000-0000-0000-000000110002');

SELECT test_expect('vjezd nese vazbu na ohlášení',
  (SELECT count(*) FROM vehicle_passages WHERE announced_arrival_id IS NOT NULL), 1);

-- ── Nový výsledek zásahu ─────────────────────────────────────────

SELECT test_expect('dispatch_outcome zná suppressed_announced',
  (SELECT count(*) FROM unnest(enum_range(NULL::dispatch_outcome)) v
   WHERE v::text = 'suppressed_announced'), 1);

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d0002"}';

-- Token je přístupový údaj, ne provozní data. Klient na dopravce nevidí.
SELECT test_expect('klient na dopravce nevidí', (SELECT count(*) FROM carriers), 0);

-- Ohlášení naopak vidí — jsou to provozní data k vjezdům. Ale jen
-- ze své lokality.
SELECT test_expect('klient vidí ohlášení své lokality',
  (SELECT count(*) FROM announced_arrivals), 3);

DO $$
BEGIN
  INSERT INTO carriers (site_id, name, token)
  VALUES ('00000000-0000-0000-0000-0000000e0001', 'Vlastní',
          'ccccccccccccccccccccccccccccccccccccccccccc');
  RAISE EXCEPTION 'FAIL  klient založil dopravce, ačkoli neměl';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient dopravce nezaloží — odmítnuto politikou';
END $$;

-- Ohlášení zakládá výhradně stránka řidiče pod service_role.
DO $$
BEGIN
  INSERT INTO announced_arrivals (carrier_id, site_id, plate, arrival_date)
  VALUES ('00000000-0000-0000-0000-0000000f0001',
          '00000000-0000-0000-0000-0000000e0001', '5XY1111', CURRENT_DATE);
  RAISE EXCEPTION 'FAIL  klient založil ohlášení, ačkoli neměl';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient ohlášení nezaloží — odmítnuto právy';
END $$;

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d0001"}';
SELECT test_expect('admin vidí všechny dopravce', (SELECT count(*) FROM carriers), 2);
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
