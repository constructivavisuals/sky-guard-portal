-- Kamerový modul: schopnosti lokality, FTP kamery a záznamy.
--
-- Podstatné je, že se dvě různé důvěryhodnosti nepotkají v jednom
-- řádku (FTP kamera nesmí mít ingest klíč) a že se klient nedostane
-- k záznamům cizí lokality.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

BEGIN;

-- Každý testovací soubor si pomocnou funkci zakládá sám; běží
-- v transakci ukončené ROLLBACKem, takže po sobě nic nenechá.
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
  ('dddddddd-0000-0000-0000-00000000f001'),
  ('dddddddd-0000-0000-0000-00000000f002');
INSERT INTO profiles (id, email, role) VALUES
  ('dddddddd-0000-0000-0000-00000000f001', 'admin@sky-guard.cz', 'admin'),
  ('dddddddd-0000-0000-0000-00000000f002', 'stavbar@example.com', 'viewer');

-- Stavba bez dronu a areál s dronem. Klient vidí jen stavbu.
INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days,
                   has_drone, has_cameras)
VALUES
  ('dddddddd-0000-0000-0000-00000000f003', 'Stavba', 'Europe/Prague',
   '18:00', '06:00', ARRAY[1,2,3,4,5], FALSE, TRUE),
  ('dddddddd-0000-0000-0000-00000000f004', 'Areál', 'Europe/Prague',
   '18:00', '06:00', ARRAY[1,2,3,4,5], TRUE, FALSE);

INSERT INTO site_grants (profile_id, site_id) VALUES
  ('dddddddd-0000-0000-0000-00000000f002', 'dddddddd-0000-0000-0000-00000000f003');

INSERT INTO cameras (id, site_id, name, serial_number, ingest_mode, ftp_username)
VALUES
  ('dddddddd-0000-0000-0000-00000000f005', 'dddddddd-0000-0000-0000-00000000f003',
   'Jeřáb', 'BK024AAPAGB5592', 'ftp', 'cam-stavba-01'),
  ('dddddddd-0000-0000-0000-00000000f006', 'dddddddd-0000-0000-0000-00000000f004',
   'Brána', 'SG-CAM-01', 'http', NULL);

INSERT INTO camera_recordings (camera_id, started_at, ended_at, event_type,
                               sd_file_path, r2_key, size_bytes)
VALUES
  ('dddddddd-0000-0000-0000-00000000f005', now() - interval '2 hours',
   now() - interval '2 hours' + interval '43 seconds', 'motion',
   'cam-stavba-01/2026-08-27/001/dav/10/10.00.00-10.00.43[M][0@0][0].dav',
   'cameras/dddddddd-0000-0000-0000-00000000f005/2026/08/27/100000-motion.mp4',
   4194304),
  ('dddddddd-0000-0000-0000-00000000f006', now() - interval '3 hours',
   now() - interval '3 hours' + interval '20 seconds', 'motion',
   'cam-areal/2026-08-27/001/dav/09/09.00.00-09.00.20[M][0@0][0].dav',
   'cameras/dddddddd-0000-0000-0000-00000000f006/2026/08/27/090000-motion.mp4',
   1048576);

DO $$
DECLARE v_ok BOOLEAN;
BEGIN
  -- ── Schopnosti lokality ────────────────────────────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO sites (name, timezone, armed_from, armed_to, armed_days,
                       has_drone, has_cameras)
    VALUES ('Prázdná', 'Europe/Prague', '18:00', '06:00', ARRAY[1],
            FALSE, FALSE);
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL lokalita bez dronu i bez kamer prošla';
  END IF;
  RAISE NOTICE 'ok    lokalita musí mít aspoň jednu schopnost';

  -- Stávající lokality mají dron a nemají kamery.
  IF EXISTS (SELECT 1 FROM sites WHERE name = 'Areál' AND NOT has_drone) THEN
    RAISE EXCEPTION 'FAIL výchozí has_drone není TRUE';
  END IF;
  RAISE NOTICE 'ok    výchozí lokalita je areál s dronem';

  -- ── FTP kamera a klíč se nepotkají ─────────────────────────────
  v_ok := FALSE;
  BEGIN
    UPDATE cameras
       SET ingest_secret_hash = repeat('a', 64)
     WHERE id = 'dddddddd-0000-0000-0000-00000000f005';
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL FTP kamera dostala ingest klíč — tvářila by se jako ověřovaná';
  END IF;
  RAISE NOTICE 'ok    FTP kamera nesmí mít ingest klíč';

  v_ok := FALSE;
  BEGIN
    INSERT INTO cameras (site_id, name, ingest_mode)
    VALUES ('dddddddd-0000-0000-0000-00000000f003', 'Bez účtu', 'ftp');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL FTP kamera bez účtu prošla — watcher by ji nedohledal';
  END IF;
  RAISE NOTICE 'ok    FTP kamera musí mít účet';

  -- ── Heslo v názvu secretu ──────────────────────────────────────
  v_ok := FALSE;
  BEGIN
    UPDATE cameras
       SET credentials_secret_name = 'rtsp://admin:tajneheslo@10.0.0.10'
     WHERE id = 'dddddddd-0000-0000-0000-00000000f005';
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL do názvu secretu se dalo uložit heslo';
  END IF;
  RAISE NOTICE 'ok    název secretu nesmí vypadat jako heslo';

  -- ── Idempotence příjmu ─────────────────────────────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO camera_recordings (camera_id, started_at, sd_file_path)
    VALUES ('dddddddd-0000-0000-0000-00000000f005', now(),
            'cam-stavba-01/2026-08-27/001/dav/10/10.00.00-10.00.43[M][0@0][0].dav');
  EXCEPTION WHEN unique_violation THEN v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL týž soubor založil druhý řádek';
  END IF;
  RAISE NOTICE 'ok    idempotence drží na sd_file_path';

  -- Dva streamy téže kamery se stejným časem PROJDOU. V constructivě
  -- na tomhle padal sub stream kvůli zděděnému unique (camera_id,
  -- started_at) — tady ten index schválně není.
  INSERT INTO camera_recordings (camera_id, started_at, sd_file_path)
  SELECT camera_id, started_at,
         'cam-stavba-01/2026-08-27/002/dav/10/10.00.00-10.00.43[M][0@0][0].dav'
    FROM camera_recordings
   WHERE camera_id = 'dddddddd-0000-0000-0000-00000000f005'
   LIMIT 1;
  RAISE NOTICE 'ok    main i sub stream se stejným časem projdou';
END $$;

-- ── RLS ──────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000f002"}';

SELECT test_expect('stavbař vidí záznamy své stavby',
  (SELECT count(*) FROM camera_recordings
    WHERE camera_id = 'dddddddd-0000-0000-0000-00000000f005'), 2);

SELECT test_expect('na cizí areál nevidí',
  (SELECT count(*) FROM camera_recordings
    WHERE camera_id = 'dddddddd-0000-0000-0000-00000000f006'), 0);

DO $$
BEGIN
  INSERT INTO camera_recordings (camera_id, started_at, sd_file_path)
  VALUES ('dddddddd-0000-0000-0000-00000000f005', now(), 'podvrzeny.dav');
  RAISE EXCEPTION 'FAIL  klient zapsal záznam, ačkoli neměl';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok    klient záznam nezapíše — odmítnuto právy';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
