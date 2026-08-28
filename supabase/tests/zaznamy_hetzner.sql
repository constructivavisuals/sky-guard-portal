-- Přechod záznamů do Hetzneru: backend u řádku, strop a součet objemu.
--
-- Podstatné je trojí:
--   1. STÁVAJÍCÍ řádky musí zůstat 'supabase' — kdyby je migrace
--      označila za hetznerské, portál by podepisoval adresy do bucketu,
--      kde ty soubory nejsou, a historie by přestala hrát.
--   2. site_recording_bytes NENÍ security definer — na cizí lokalitu
--      musí vrátit nulu, ne skutečný objem.
--   3. Součet počítá jen to, co v úložišti doopravdy leží.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

BEGIN;

CREATE FUNCTION public.test_expect(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok    % = %', label, actual;
END $fn$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;

INSERT INTO auth.users (id) VALUES
  ('dddddddd-0000-0000-0000-00000000b001'),
  ('dddddddd-0000-0000-0000-00000000b002');
INSERT INTO profiles (id, email, role) VALUES
  ('dddddddd-0000-0000-0000-00000000b001', 'admin@sky-guard.cz', 'admin'),
  ('dddddddd-0000-0000-0000-00000000b002', 'cizi@example.com', 'viewer');

INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days,
                   has_drone, has_cameras)
VALUES ('dddddddd-0000-0000-0000-00000000b003', 'Klanečná', 'Europe/Prague',
        '18:00', '06:00', ARRAY[1,2,3,4,5], FALSE, TRUE);

INSERT INTO cameras (id, site_id, name, serial_number, ingest_mode, ftp_username)
VALUES ('dddddddd-0000-0000-0000-00000000b004',
        'dddddddd-0000-0000-0000-00000000b003', 'Jeřáb',
        'BK024AAPAGB5592', 'ftp', 'cam-klanecna-01');

-- ── Výchozí hodnoty ──────────────────────────────────────────────

SELECT test_expect('výchozí strop je 500 GB dekadických',
  (SELECT recording_quota_bytes FROM sites
    WHERE id = 'dddddddd-0000-0000-0000-00000000b003'), 500000000000);

-- Řádek bez uvedeného backendu má dostat 'hetzner' — to je nový default.
INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path,
                               uploaded_at, size_bytes)
VALUES ('dddddddd-0000-0000-0000-00000000b004', '2026-08-27T06:00:00Z',
        'novy.dav', 'x/novy.mp4', now(), 50000000);

SELECT test_expect('nový záznam jde do Hetzneru',
  (SELECT count(*) FROM camera_recordings
    WHERE sd_file_path = 'novy.dav' AND storage_backend = 'hetzner'), 1);

-- ── Součet objemu ────────────────────────────────────────────────
--
-- Do stropu se smí počítat jen to, co místo doopravdy zabírá.

INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path,
                               uploaded_at, size_bytes, video_expired_at)
VALUES ('dddddddd-0000-0000-0000-00000000b004', '2026-08-01T06:00:00Z',
        'smazany.dav', 'x/smazany.mp4', now(), 900000000, now());

INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path,
                               size_bytes)
VALUES ('dddddddd-0000-0000-0000-00000000b004', '2026-08-27T07:00:00Z',
        'nedorazil.dav', 'x/nedorazil.mp4', 700000000);

SELECT test_expect('smazané ani nepotvrzené video se do stropu nepočítá',
  site_recording_bytes('dddddddd-0000-0000-0000-00000000b003'), 50000000);

-- ── Zpětné doplnění u STÁVAJÍCÍCH řádků ──────────────────────────
--
-- Nejdůležitější vlastnost celé migrace a jediná, kterou nejde ověřit
-- vložením řádku po ní: záznam, který v tabulce ležel PŘED přechodem,
-- musí dostat 'supabase'. Kdyby dostal 'hetzner', portál by mu
-- podepisoval adresy do bucketu, kde ten soubor není, a všechna
-- historie by přestala hrát — tiše, protože řádek i cesta by seděly.
--
-- Simuluje se to odebráním sloupce a novým spuštěním migrace. Zároveň
-- je to test idempotence: migrace se pouští ručně a druhé spuštění
-- nesmí nic rozbít.

ALTER TABLE camera_recordings DROP COLUMN storage_backend;

INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path,
                               uploaded_at, size_bytes)
VALUES ('dddddddd-0000-0000-0000-00000000b004', '2026-07-01T06:00:00Z',
        'historicky.dav', 'x/historicky.mp4', now(), 10000000);

\i supabase/migrations/20260918120000_zaznamy_hetzner.sql

SELECT test_expect('záznam z doby před přechodem zůstal v Supabase',
  (SELECT count(*) FROM camera_recordings
    WHERE sd_file_path = 'historicky.dav' AND storage_backend = 'supabase'), 1);

-- Po odebrání a novém přidání sloupce nesmí být hetznerský ŽÁDNÝ:
-- všechny existující řádky se berou za historii.
SELECT test_expect('po doplnění sloupce není hetznerský žádný stávající řádek',
  (SELECT count(*) FROM camera_recordings
    WHERE storage_backend = 'hetzner'), 0);

INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path,
                               uploaded_at, size_bytes)
VALUES ('dddddddd-0000-0000-0000-00000000b004', '2026-08-28T06:00:00Z',
        'popremigraci.dav', 'x/po.mp4', now(), 10000000);

SELECT test_expect('nový záznam po druhém spuštění migrace je hetznerský',
  (SELECT count(*) FROM camera_recordings
    WHERE sd_file_path = 'popremigraci.dav' AND storage_backend = 'hetzner'), 1);

-- ── CHECK na neznámý backend ─────────────────────────────────────

DO $$
BEGIN
  BEGIN
    INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_backend)
    VALUES ('dddddddd-0000-0000-0000-00000000b004', now(), 'spatny.dav', 'r2');
    RAISE EXCEPTION 'FAIL neznámý backend prošel';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok    neznámý backend CHECK zastaví';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE sites SET recording_quota_bytes = 0
     WHERE id = 'dddddddd-0000-0000-0000-00000000b003';
    RAISE EXCEPTION 'FAIL nulový strop prošel';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok    nulový strop CHECK zastaví';
  END;
END $$;

-- ── RLS: funkce běží právy volajícího ────────────────────────────

SET LOCAL ROLE authenticated;

SET LOCAL request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000b002"}';
SELECT test_expect('cizí uživatel objem lokality nezjistí',
  site_recording_bytes('dddddddd-0000-0000-0000-00000000b003'), 0);

SET LOCAL request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000b001"}';
-- 50 MB původní + 10 MB historický + 10 MB po migraci. Smazaný
-- a nepotvrzený se nepočítají ani teď.
SELECT test_expect('admin objem vidí',
  site_recording_bytes('dddddddd-0000-0000-0000-00000000b003'), 70000000);

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
