-- Schopnosti kamery: výchozí hodnoty a omezení, na která spoléhá kód.
--
-- Ingest bere plate z těla požadavku jen u kamery s reads_plate a čeká,
-- že taková kamera umí i vozidla — vjezd JE detekce vozidla. Kdyby to
-- databáze nehlídala, dala by se založit kamera, která si každým
-- vjezdem sama hlásí neočekávanou událost.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

BEGIN;

INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days)
VALUES ('bbbbbbbb-0000-0000-0000-00000000c001', 'Test kamer', 'Europe/Prague',
        '18:00', '06:00', ARRAY[1,2,3,4,5]);

DO $$
DECLARE
  v_person  BOOLEAN;
  v_vehicle BOOLEAN;
  v_plate   BOOLEAN;
  v_ok      BOOLEAN;
BEGIN
  -- ── Výchozí stav: perimetr umí osobu a nic víc ─────────────────
  INSERT INTO cameras (id, site_id, name)
  VALUES ('bbbbbbbb-0000-0000-0000-00000000c002',
          'bbbbbbbb-0000-0000-0000-00000000c001', 'Perimetr sever');

  SELECT detects_person, detects_vehicle, reads_plate
    INTO v_person, v_vehicle, v_plate
    FROM cameras WHERE id = 'bbbbbbbb-0000-0000-0000-00000000c002';

  IF v_person IS NOT TRUE OR v_vehicle IS NOT FALSE OR v_plate IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL výchozí schopnosti nejsou osoba/ne/ne, ale %/%/%',
      v_person, v_vehicle, v_plate;
  END IF;
  RAISE NOTICE 'ok    výchozí kamera umí jen osobu';

  -- ── Brána: osoba, vozidlo, značka ──────────────────────────────
  INSERT INTO cameras (site_id, name, detects_person, detects_vehicle, reads_plate)
  VALUES ('bbbbbbbb-0000-0000-0000-00000000c001', 'Vrátnice', TRUE, TRUE, TRUE);
  RAISE NOTICE 'ok    kamera na vrátnici se založí se všemi schopnostmi';

  -- ── Čtení značky bez vozidel NESMÍ projít ──────────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO cameras (site_id, name, detects_vehicle, reads_plate)
    VALUES ('bbbbbbbb-0000-0000-0000-00000000c001', 'Zmatená', FALSE, TRUE);
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL kamera se čtením značek bez detekce vozidel prošla';
  END IF;
  RAISE NOTICE 'ok    reads_plate bez detects_vehicle neprojde';

  -- ── Totéž při úpravě, ne jen při zakládání ─────────────────────
  v_ok := FALSE;
  BEGIN
    UPDATE cameras SET detects_vehicle = FALSE WHERE name = 'Vrátnice';
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL vypnutí vozidel u kamery se čtením značek prošlo';
  END IF;
  RAISE NOTICE 'ok    schopnost nejde odebrat ani úpravou';

  RAISE NOTICE 'VŠECHNY TESTY PROŠLY';
END $$;

ROLLBACK;
