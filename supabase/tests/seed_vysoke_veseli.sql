-- Ověření seedu kamer pro Vysoké Veselí. Běží v transakci s ROLLBACKem.
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

INSERT INTO sites (name, timezone) VALUES ('Vysoké Veselí', 'Europe/Prague');

\i supabase/seed/vysoke_veseli_cameras.sql
-- Podruhé: seed musí být idempotentní, aby šel pustit po opravě znovu.
\i supabase/seed/vysoke_veseli_cameras.sql

SELECT test_expect('po dvou bězích je kamer pět',
  (SELECT count(*) FROM cameras WHERE serial_number LIKE 'CAM-VV-%'), 5);

SELECT test_expect('všechny mají bod, azimut i ohnisko',
  (SELECT count(*) FROM cameras
    WHERE serial_number LIKE 'CAM-VV-%'
      AND location IS NOT NULL AND azimuth IS NOT NULL AND focal_mm = 6), 5);

SELECT test_expect('všechny jsou offline a bez zóny',
  (SELECT count(*) FROM cameras
    WHERE serial_number LIKE 'CAM-VV-%'
      AND status = 'offline' AND zone_id IS NULL), 5);

-- Záměna šířky a délky je při ručním psaní ST_MakePoint nejčastější
-- chyba a v Česku by ji nic jiného nechytlo — obojí je kladné číslo.
SELECT test_expect('žádná kamera nemá prohozenou šířku s délkou',
  (SELECT count(*) FROM cameras
    WHERE serial_number LIKE 'CAM-VV-%'
      AND ST_Y(location::geometry) BETWEEN 50.32 AND 50.34
      AND ST_X(location::geometry) BETWEEN 15.42 AND 15.43), 5);

SELECT test_expect('JV roh kouká na jih',
  (SELECT azimuth FROM cameras WHERE serial_number = 'CAM-VV-01'), 180);
SELECT test_expect('Střed SV kouká na severovýchod',
  (SELECT azimuth FROM cameras WHERE serial_number = 'CAM-VV-03'), 45);
SELECT test_expect('JZ roh kouká na východ',
  (SELECT azimuth FROM cameras WHERE serial_number = 'CAM-VV-05'), 90);

-- Všechny musí ležet uvnitř výřezu podkladu, jinak se nevykreslí.
SELECT test_expect('všech pět leží uvnitř rohů podkladu',
  (SELECT count(*) FROM cameras
    WHERE serial_number LIKE 'CAM-VV-%'
      AND ST_Y(location::geometry) BETWEEN 50.329457 AND 50.331201
      AND ST_X(location::geometry) BETWEEN 15.424061 AND 15.427197), 5);

-- ── Zóny a přiřazení kamer ───────────────────────────────────────

\i supabase/seed/vysoke_veseli_zones.sql
-- Podruhé: taky idempotentní.
\i supabase/seed/vysoke_veseli_zones.sql

SELECT test_expect('vznikly dvě zóny, ne čtyři',
  (SELECT count(*) FROM zones), 2);

SELECT test_expect('žádná kamera nezůstala bez zóny',
  (SELECT count(*) FROM cameras
    WHERE serial_number LIKE 'CAM-VV-%' AND zone_id IS NULL), 0);

SELECT test_expect('Jihozápadní má rohy JV a JZ',
  (SELECT count(*) FROM cameras c JOIN zones z ON z.id = c.zone_id
    WHERE z.name = 'Jihozápadní'
      AND c.serial_number IN ('CAM-VV-01', 'CAM-VV-05')), 2);

SELECT test_expect('a nic jiného',
  (SELECT count(*) FROM cameras c JOIN zones z ON z.id = c.zone_id
    WHERE z.name = 'Jihozápadní'), 2);

SELECT test_expect('Severovýchodní má zbylé tři',
  (SELECT count(*) FROM cameras c JOIN zones z ON z.id = c.zone_id
    WHERE z.name = 'Severovýchodní'), 3);

-- Zóna bez waypointu dá outcome 'failed' — dron by neměl kam letět.
SELECT test_expect('obě zóny mají waypoint',
  (SELECT count(*) FROM zones WHERE location IS NOT NULL), 2);

-- Těžiště musí ležet mezi svými kamerami, ne někde vedle.
SELECT test_expect('těžiště Jihozápadní leží mezi jejími kamerami',
  (SELECT count(*) FROM zones z
    WHERE z.name = 'Jihozápadní'
      AND ST_Y(z.location::geometry) BETWEEN 50.329607 AND 50.329649
      AND ST_X(z.location::geometry) BETWEEN 15.424217 AND 15.426257), 1);

SELECT test_expect('těžiště obou zón leží uvnitř rohů podkladu',
  (SELECT count(*) FROM zones
    WHERE ST_Y(location::geometry) BETWEEN 50.329457 AND 50.331201
      AND ST_X(location::geometry) BETWEEN 15.424061 AND 15.427197), 2);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
