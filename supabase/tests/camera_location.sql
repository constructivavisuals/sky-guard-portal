-- Test místa a směru kamery. Běží v transakci s ROLLBACKem.
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
  WHEN check_violation THEN RAISE NOTICE 'ok    % — odmítnuto omezením', label;
END $$;

INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Areál Kralupy', 'Europe/Prague');

-- ── Výchozí hodnoty ──────────────────────────────────────────────

INSERT INTO cameras (id, site_id, name)
VALUES ('00000000-0000-0000-0000-000000000071',
        '00000000-0000-0000-0000-000000000001', 'Bez montáže');

SELECT test_expect('kamera bez montáže má dosah 30 m',
  (SELECT range_m FROM cameras WHERE id = '00000000-0000-0000-0000-000000000071'), 30);
SELECT test_expect('a nemá ani bod, ani azimut',
  (SELECT count(*) FROM cameras
    WHERE id = '00000000-0000-0000-0000-000000000071'
      AND location IS NULL AND azimuth IS NULL), 1);

-- ── Rozsah azimutu ───────────────────────────────────────────────

INSERT INTO cameras (id, site_id, name, azimuth, location)
VALUES ('00000000-0000-0000-0000-000000000072',
        '00000000-0000-0000-0000-000000000001', 'JV roh', 180,
        ST_SetSRID(ST_MakePoint(15.426257, 50.329607), 4326)::geography);

SELECT test_expect('bod se uložil jako geography',
  (SELECT count(*) FROM cameras
    WHERE id = '00000000-0000-0000-0000-000000000072'
      AND ST_SRID(location::geometry) = 4326), 1);

SELECT test_expect('zeměpisná délka se nezaměnila se šířkou',
  (SELECT round(ST_X(location::geometry) * 1000)::BIGINT FROM cameras
    WHERE id = '00000000-0000-0000-0000-000000000072'), 15426);

SELECT test_expect_rejected('azimut 360 neprojde', $sql$
  INSERT INTO cameras (site_id, name, azimuth)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Přetočená', 360)
$sql$);

SELECT test_expect_rejected('záporný azimut neprojde', $sql$
  INSERT INTO cameras (site_id, name, azimuth)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Záporná', -1)
$sql$);

INSERT INTO cameras (site_id, name, azimuth) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Sever', 0),
  ('00000000-0000-0000-0000-000000000001', 'Skoro sever', 359);

SELECT test_expect('azimut 0 i 359 projdou',
  (SELECT count(*) FROM cameras WHERE azimuth IN (0, 359)), 2);

-- ── Rozsah dosahu ────────────────────────────────────────────────

SELECT test_expect_rejected('nulový dosah neprojde', $sql$
  INSERT INTO cameras (site_id, name, range_m)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Slepá', 0)
$sql$);

SELECT test_expect_rejected('dosah přes kilometr neprojde', $sql$
  INSERT INTO cameras (site_id, name, range_m)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Dalekohled', 1001)
$sql$);

-- ── Vzdálenost mezi kamerami ─────────────────────────────────────
-- Kontroluje, že sloupec je geography (metry), ne geometry (stupně).

INSERT INTO cameras (id, site_id, name, location)
VALUES ('00000000-0000-0000-0000-000000000073',
        '00000000-0000-0000-0000-000000000001', 'Východ',
        ST_SetSRID(ST_MakePoint(15.426531, 50.330440), 4326)::geography);

SELECT test_expect('JV roh a Východ jsou od sebe 95 m',
  (SELECT round(ST_Distance(a.location, b.location))::BIGINT
     FROM cameras a, cameras b
    WHERE a.id = '00000000-0000-0000-0000-000000000072'
      AND b.id = '00000000-0000-0000-0000-000000000073'), 95);

-- ── Ingest klíč kamery ───────────────────────────────────────────

SELECT test_expect('nová kamera je na společném tajemství',
  (SELECT count(*) FROM cameras
    WHERE id = '00000000-0000-0000-0000-000000000071'
      AND ingest_secret_hash IS NULL AND ingest_key_version = 1), 1);

-- Kdyby sem někdo omylem uložil klíč místo otisku, CHECK to zachytí.
SELECT test_expect_rejected('do otisku nejde uložit cokoli', $sql$
  UPDATE cameras SET ingest_secret_hash = 'tajny-klic'
   WHERE id = '00000000-0000-0000-0000-000000000071'
$sql$);

SELECT test_expect_rejected('otisk s velkými písmeny neprojde', $sql$
  UPDATE cameras SET ingest_secret_hash = repeat('A', 64)
   WHERE id = '00000000-0000-0000-0000-000000000071'
$sql$);

SELECT test_expect_rejected('nulová verze klíče neprojde', $sql$
  UPDATE cameras SET ingest_key_version = 0
   WHERE id = '00000000-0000-0000-0000-000000000071'
$sql$);

-- Ingest dohledává kameru podle sériového čísla; bez něj by byl otisk
-- mrtvý údaj, protože by se k němu nešlo dostat.
SELECT test_expect_rejected('otisk bez sériového čísla neprojde', $sql$
  UPDATE cameras SET ingest_secret_hash = repeat('a', 64)
   WHERE id = '00000000-0000-0000-0000-000000000071'
$sql$);

UPDATE cameras SET serial_number = 'CAM-TEST-01', ingest_secret_hash = repeat('a', 64)
 WHERE id = '00000000-0000-0000-0000-000000000071';

SELECT test_expect('se sériovým číslem otisk projde',
  (SELECT count(*) FROM cameras
    WHERE id = '00000000-0000-0000-0000-000000000071'
      AND ingest_secret_hash = repeat('a', 64)), 1);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
