-- Počty záznamů po dnech.
--
-- Podstatné je, že funkce NENÍ security definer: kdyby byla, stačilo by
-- uhodnout UUID lokality a šlo by zjistit, kdy se natáčelo na cizí
-- stavbě. A že den je den LOKALITY — v UTC by se letní večer po 22:00
-- přelil do dalšího dne.

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
  ('eeeeeeee-0000-0000-0000-00000000a001'),
  ('eeeeeeee-0000-0000-0000-00000000a002');
INSERT INTO profiles (id, email, role) VALUES
  ('eeeeeeee-0000-0000-0000-00000000a001', 'admin@sky-guard.cz', 'admin'),
  ('eeeeeeee-0000-0000-0000-00000000a002', 'cizi@example.com', 'viewer');

INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days,
                   has_drone, has_cameras)
VALUES ('eeeeeeee-0000-0000-0000-00000000a003', 'Klanečná', 'Europe/Prague',
        '18:00', '06:00', ARRAY[1,2,3,4,5], FALSE, TRUE);

INSERT INTO cameras (id, site_id, name, serial_number, ingest_mode, ftp_username)
VALUES ('eeeeeeee-0000-0000-0000-00000000a004',
        'eeeeeeee-0000-0000-0000-00000000a003', 'Jeřáb',
        'BK024AAPAGB5592', 'ftp', 'cam-klanecna-01');

-- 27. 8. místního času: 08:00 a 21:30 (tedy 06:00 a 19:30 UTC).
-- A jeden záznam ve 23:30 UTC, což je UŽ 28. 8. v Praze — právě na
-- tomhle se pozná, jestli se počítá v pásmu lokality, nebo v UTC.
INSERT INTO camera_recordings (camera_id, started_at, sd_file_path, storage_path, uploaded_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000a004', '2026-08-27T06:00:00Z', 'a.dav', 'x/a.mp4', now()),
  ('eeeeeeee-0000-0000-0000-00000000a004', '2026-08-27T19:30:00Z', 'b.dav', 'x/b.mp4', now()),
  ('eeeeeeee-0000-0000-0000-00000000a004', '2026-08-27T23:30:00Z', 'c.dav', 'x/c.mp4', now());

DO $$
DECLARE v_pocet BIGINT;
BEGIN
  SELECT recordings INTO v_pocet
    FROM camera_recording_day_counts('eeeeeeee-0000-0000-0000-00000000a003')
   WHERE day = DATE '2026-08-27';
  IF v_pocet IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 27. 8. má mít 2 záznamy, má %', v_pocet;
  END IF;
  RAISE NOTICE 'ok    den se počítá v pásmu lokality (27. 8. = 2)';

  SELECT recordings INTO v_pocet
    FROM camera_recording_day_counts('eeeeeeee-0000-0000-0000-00000000a003')
   WHERE day = DATE '2026-08-28';
  IF v_pocet IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 23:30 UTC patří do 28. 8., dostal %', v_pocet;
  END IF;
  RAISE NOTICE 'ok    záznam po 22:00 UTC spadá do dalšího místního dne';
END $$;

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"eeeeeeee-0000-0000-0000-00000000a002"}';

SELECT test_expect('cizí uživatel nedostane žádné počty',
  (SELECT count(*) FROM camera_recording_day_counts('eeeeeeee-0000-0000-0000-00000000a003')), 0);

SET LOCAL request.jwt.claims = '{"sub":"eeeeeeee-0000-0000-0000-00000000a001"}';

SELECT test_expect('admin počty vidí',
  (SELECT count(*) FROM camera_recording_day_counts('eeeeeeee-0000-0000-0000-00000000a003')), 2);

SELECT test_expect('filtr na kameru platí',
  (SELECT count(*) FROM camera_recording_day_counts(
     'eeeeeeee-0000-0000-0000-00000000a003',
     'eeeeeeee-0000-0000-0000-00000000a004')), 2);

SELECT test_expect('cizí kamera nevrátí nic',
  (SELECT count(*) FROM camera_recording_day_counts(
     'eeeeeeee-0000-0000-0000-00000000a003',
     'eeeeeeee-0000-0000-0000-0000000000ff')), 0);

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
