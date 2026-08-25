-- ═══════════════════════════════════════════════════════════════════
-- Pět kamer na Vysokém Veselí.
--
-- Data, ne schéma — proto mimo supabase/migrations/. Spouští se ručně
-- a jen jednou; opakovaný běh sériová čísla jen aktualizuje.
--
-- Zóna se nepřiřazuje: kamera bez zóny detekuje, ale zásah z ní
-- nevznikne. Doplní se, až budou zóny zaměřené.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$
DECLARE
  v_site UUID;
  v_count BIGINT;
BEGIN
  SELECT id INTO v_site FROM sites WHERE name ILIKE '%vysoké veselí%' LIMIT 1;

  IF v_site IS NULL THEN
    RAISE EXCEPTION 'Lokalita Vysoké Veselí neexistuje — nejdřív ji založte.';
  END IF;

  -- Konflikt na sériovém čísle, ne na názvu: název jde přejmenovat,
  -- štítek na krabici ne.
  INSERT INTO cameras (site_id, name, model, serial_number, focal_mm,
                       location, azimuth, range_m, status)
  VALUES
    (v_site, 'JV roh',   'Dahua HFW2xxx-AS-IL', 'CAM-VV-01', 6,
     ST_SetSRID(ST_MakePoint(15.426257, 50.329607), 4326)::geography, 180, 30, 'offline'),
    (v_site, 'Východ',   'Dahua HFW2xxx-AS-IL', 'CAM-VV-02', 6,
     ST_SetSRID(ST_MakePoint(15.426531, 50.330440), 4326)::geography, 180, 30, 'offline'),
    (v_site, 'Střed SV', 'Dahua HFW2xxx-AS-IL', 'CAM-VV-03', 6,
     ST_SetSRID(ST_MakePoint(15.425131, 50.330622), 4326)::geography, 45,  30, 'offline'),
    (v_site, 'Západ',    'Dahua HFW2xxx-AS-IL', 'CAM-VV-04', 6,
     ST_SetSRID(ST_MakePoint(15.424164, 50.330376), 4326)::geography, 180, 30, 'offline'),
    (v_site, 'JZ roh',   'Dahua HFW2xxx-AS-IL', 'CAM-VV-05', 6,
     ST_SetSRID(ST_MakePoint(15.424217, 50.329649), 4326)::geography, 90,  30, 'offline')
  ON CONFLICT (serial_number) DO UPDATE SET
    name      = EXCLUDED.name,
    model     = EXCLUDED.model,
    focal_mm  = EXCLUDED.focal_mm,
    location  = EXCLUDED.location,
    azimuth   = EXCLUDED.azimuth,
    range_m   = EXCLUDED.range_m,
    updated_at = now();

  SELECT count(*) INTO v_count FROM cameras
   WHERE site_id = v_site AND serial_number LIKE 'CAM-VV-%';
  RAISE NOTICE 'Na Vysokém Veselí je % kamer.', v_count;
END $$;
