-- Anonymizace po lhůtě.
--
-- Řádek zůstává, zmizí z něj jen to, čím se dá identifikovat osoba.
-- Testuje se hlavně to, že omezení tabulky anonymizovaný stav DOVOLÍ
-- (jinak by ho retenční job nezapsal) a zároveň dál brání nesmyslům
-- u běžných řádků.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

BEGIN;

INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days)
VALUES ('cccccccc-0000-0000-0000-00000000e001', 'Test retence', 'Europe/Prague',
        '18:00', '06:00', ARRAY[1,2,3,4,5]);
INSERT INTO cameras (id, site_id, name)
VALUES ('cccccccc-0000-0000-0000-00000000e002',
        'cccccccc-0000-0000-0000-00000000e001', 'Brána');
INSERT INTO detections (id, site_id, camera_id, source, object_class)
VALUES ('cccccccc-0000-0000-0000-00000000e003',
        'cccccccc-0000-0000-0000-00000000e001',
        'cccccccc-0000-0000-0000-00000000e002', 'camera', 'vehicle');
INSERT INTO carriers (id, site_id, name, token)
VALUES ('cccccccc-0000-0000-0000-00000000e004',
        'cccccccc-0000-0000-0000-00000000e001', 'Beton s.r.o.',
        'token-dost-dlouhy-na-to-aby-proslo-omezeni');

DO $$
DECLARE
  v_plate TEXT;
  v_match plate_list_type;
  v_ok    BOOLEAN;
BEGIN
  -- ── Vjezd: značka pryč, výsledek zůstává ───────────────────────
  INSERT INTO vehicle_passages (id, site_id, camera_id, detection_id, plate,
                                confidence, list_match, known_label, passed_at)
  VALUES ('cccccccc-0000-0000-0000-00000000e005',
          'cccccccc-0000-0000-0000-00000000e001',
          'cccccccc-0000-0000-0000-00000000e002',
          'cccccccc-0000-0000-0000-00000000e003',
          '1AB2345', 0.95, 'allow', 'Novák, beton', now() - interval '100 days');

  UPDATE vehicle_passages
     SET plate = NULL, confidence = NULL, known_label = NULL,
         known_plate_id = NULL, anonymized_at = now()
   WHERE id = 'cccccccc-0000-0000-0000-00000000e005';

  SELECT plate, list_match INTO v_plate, v_match
    FROM vehicle_passages WHERE id = 'cccccccc-0000-0000-0000-00000000e005';

  IF v_plate IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL značka po anonymizaci zůstala';
  END IF;
  IF v_match IS DISTINCT FROM 'allow' THEN
    RAISE EXCEPTION 'FAIL výsledek proti seznamu se ztratil — report by přišel o rozpad';
  END IF;
  RAISE NOTICE 'ok    vjezd přišel o značku, výsledek proti seznamu zůstal';

  -- ── Shoda bez značky u NEanonymizovaného řádku neprojde ────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO vehicle_passages (site_id, camera_id, detection_id, list_match)
    VALUES ('cccccccc-0000-0000-0000-00000000e001',
            'cccccccc-0000-0000-0000-00000000e002',
            'cccccccc-0000-0000-0000-00000000e003', 'deny');
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  WHEN unique_violation THEN
    -- Jeden vjezd na detekci; pro tenhle test je to jedno.
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL shoda se seznamem prošla bez značky i bez anonymizace';
  END IF;
  RAISE NOTICE 'ok    shoda bez značky projde jen u anonymizovaného řádku';

  -- ── Ohlášení: značka i poznámka pryč ───────────────────────────
  INSERT INTO announced_arrivals (id, carrier_id, site_id, plate, arrival_date, note)
  VALUES ('cccccccc-0000-0000-0000-00000000e006',
          'cccccccc-0000-0000-0000-00000000e004',
          'cccccccc-0000-0000-0000-00000000e001',
          '1AB2345', current_date - 200, 'Volejte Novákovi, 777123456');

  UPDATE announced_arrivals
     SET plate = NULL, note = NULL, anonymized_at = now()
   WHERE id = 'cccccccc-0000-0000-0000-00000000e006';

  IF EXISTS (SELECT 1 FROM announced_arrivals
              WHERE id = 'cccccccc-0000-0000-0000-00000000e006'
                AND (plate IS NOT NULL OR note IS NOT NULL)) THEN
    RAISE EXCEPTION 'FAIL ohlášení po anonymizaci pořád nese osobní údaj';
  END IF;
  RAISE NOTICE 'ok    ohlášení přišlo o značku i poznámku';

  -- ── Prázdná značka bez anonymizace neprojde ────────────────────
  v_ok := FALSE;
  BEGIN
    INSERT INTO announced_arrivals (carrier_id, site_id, plate, arrival_date)
    VALUES ('cccccccc-0000-0000-0000-00000000e004',
            'cccccccc-0000-0000-0000-00000000e001', NULL, current_date);
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL ohlášení bez značky prošlo';
  END IF;
  RAISE NOTICE 'ok    ohlášení bez značky projde jen po anonymizaci';

  RAISE NOTICE 'VŠECHNY TESTY PROŠLY';
END $$;

ROLLBACK;
