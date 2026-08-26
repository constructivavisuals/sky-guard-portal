-- Test auditního deníku. Běží v transakci s ROLLBACKem.
--
-- Zapisuje trigger audit_row(), ne aplikace — tohle ověřuje, že
-- trigger sedí na správných tabulkách a že se do deníku nedostanou
-- přístupové údaje.
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

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-00000000a002');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-00000000a002', 'klient@example.com', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-00000000b001', 'Areál', 'Europe/Prague');

-- ── Nově pokryté tabulky ─────────────────────────────────────────

INSERT INTO known_plates (id, site_id, plate, list_type) VALUES
  ('00000000-0000-0000-0000-00000000c001',
   '00000000-0000-0000-0000-00000000b001', '1AB 2345', 'allow');
SELECT test_expect('přidání značky se zapsalo',
  (SELECT count(*) FROM audit_log WHERE entity_type = 'known_plates'), 1);

INSERT INTO patrols (id, site_id, name, wayline_uuid, window_from, window_to, days, interval_minutes)
VALUES ('00000000-0000-0000-0000-00000000c002',
        '00000000-0000-0000-0000-00000000b001', 'Noční okruh', 'wl-1',
        '22:00', '06:00', ARRAY[1,2,3,4,5,6,7], 60);
SELECT test_expect('založení hlídky se zapsalo',
  (SELECT count(*) FROM audit_log WHERE entity_type = 'patrols'), 1);

INSERT INTO carriers (id, site_id, name, token) VALUES
  ('00000000-0000-0000-0000-00000000c003',
   '00000000-0000-0000-0000-00000000b001', 'Beton Novák',
   'tajnytokentajnytokentajnytokentajnytoken123');
SELECT test_expect('založení dopravce se zapsalo',
  (SELECT count(*) FROM audit_log WHERE entity_type = 'carriers'), 1);

-- ── Tajemství se do deníku nedostanou ────────────────────────────
--
-- Deník je append-only, takže co se do něj jednou dostane, tam zůstane
-- i po rotaci odkazu.
SELECT test_expect('token dopravce v deníku není',
  (SELECT count(*) FROM audit_log
   WHERE metadata::text LIKE '%tajnytoken%'), 0);
SELECT test_expect('a klíč sloupce taky ne',
  (SELECT count(*) FROM audit_log
   WHERE entity_type = 'carriers' AND metadata->'new' ? 'token'), 0);

-- ── Úprava zapíše jen změněná pole ───────────────────────────────

UPDATE known_plates SET label = 'Dodávka stavby'
WHERE id = '00000000-0000-0000-0000-00000000c001';
SELECT test_expect('úprava se zapsala jako update',
  (SELECT count(*) FROM audit_log
   WHERE entity_type = 'known_plates' AND action = 'update'), 1);
SELECT test_expect('a nese jen změněné pole',
  (SELECT count(*) FROM audit_log
   WHERE entity_type = 'known_plates' AND action = 'update'
     AND metadata->'changed' ? 'label'
     AND NOT metadata->'changed' ? 'plate'), 1);

-- Samotné dotčení updated_at se nezapisuje.
UPDATE known_plates SET label = 'Dodávka stavby'
WHERE id = '00000000-0000-0000-0000-00000000c001';
SELECT test_expect('zápis beze změny nevznikl',
  (SELECT count(*) FROM audit_log
   WHERE entity_type = 'known_plates' AND action = 'update'), 1);

-- ── Události se neauditují ───────────────────────────────────────
--
-- Vjezdy a detekce jsou samy o sobě záznamem; vysokofrekvenční ingest
-- by deník zahltil.
INSERT INTO zones (id, site_id, name) VALUES
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000b001', 'Brána');
INSERT INTO cameras (id, site_id, zone_id, name) VALUES
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000b001',
   '00000000-0000-0000-0000-00000000d001', 'Brána');
INSERT INTO detections (source, site_id, camera_id, object_class)
VALUES ('camera', '00000000-0000-0000-0000-00000000b001',
        '00000000-0000-0000-0000-00000000d002', 'person');
SELECT test_expect('detekce se do deníku nezapisuje',
  (SELECT count(*) FROM audit_log WHERE entity_type = 'detections'), 0);

-- ── Autor a čtení ────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a001"}';

UPDATE sites SET name = 'Areál II' WHERE id = '00000000-0000-0000-0000-00000000b001';
SELECT test_expect('autor se bere z auth.uid()',
  (SELECT count(*) FROM audit_log
   WHERE entity_type = 'sites' AND action = 'update'
     AND actor_id = '00000000-0000-0000-0000-00000000a001'), 1);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a002"}';
SELECT test_expect('klient deník nevidí', (SELECT count(*) FROM audit_log), 0);
RESET ROLE;

-- ── Append-only ──────────────────────────────────────────────────

DO $$
BEGIN
  UPDATE audit_log SET action = 'podvrh';
  RAISE EXCEPTION 'FAIL  zápis v deníku šel přepsat';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'ok    zápis v deníku nejde přepsat';
END $$;

DO $$
BEGIN
  DELETE FROM audit_log;
  RAISE EXCEPTION 'FAIL  zápis v deníku šel smazat';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'ok    zápis v deníku nejde smazat';
END $$;

-- ── Autor jde připojit ───────────────────────────────────────────

SELECT test_expect('cizí klíč na profil existuje',
  (SELECT count(*) FROM pg_constraint WHERE conname = 'audit_log_actor_id_fkey'), 1);

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
