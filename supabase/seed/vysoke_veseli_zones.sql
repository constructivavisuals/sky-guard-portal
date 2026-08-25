-- ═══════════════════════════════════════════════════════════════════
-- Zóny pro Vysoké Veselí a přiřazení kamer.
--
-- PROVIZORNÍ rozdělení, doladí se po montáži. Kamera bez zóny detekuje,
-- ale zásah z ní nikdy nevznikne — runDispatch() ji rovnou odloží
-- a v dispatches po ní nezůstane řádek. Dokud tohle neproběhne, je
-- ingest na téhle lokalitě slepý.
--
-- Waypoint zóny se nezadává ručně: dopočítá se jako těžiště kamer,
-- které do ní patří. Ruční číslo by po přeskládání kamer tiše zůstalo
-- ukazovat jinam.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$
DECLARE
  v_site UUID;
  v_jz   UUID;
  v_sv   UUID;
  v_bez  BIGINT;
BEGIN
  SELECT id INTO v_site FROM sites WHERE name ILIKE '%vysoké veselí%' LIMIT 1;
  IF v_site IS NULL THEN
    RAISE EXCEPTION 'Lokalita Vysoké Veselí neexistuje — nejdřív ji založte.';
  END IF;

  -- Zóny. Konflikt na (site_id, lower(name)) drží unikátní index, takže
  -- opakovaný běh nezaloží druhou „Jihozápadní“.
  INSERT INTO zones (site_id, name, default_level, enabled)
  VALUES (v_site, 'Jihozápadní', 1, TRUE)
  ON CONFLICT (site_id, lower(name)) DO NOTHING;

  INSERT INTO zones (site_id, name, default_level, enabled)
  VALUES (v_site, 'Severovýchodní', 1, TRUE)
  ON CONFLICT (site_id, lower(name)) DO NOTHING;

  SELECT id INTO v_jz FROM zones
   WHERE site_id = v_site AND lower(name) = lower('Jihozápadní');
  SELECT id INTO v_sv FROM zones
   WHERE site_id = v_site AND lower(name) = lower('Severovýchodní');

  -- Přiřazení podle sériových čísel, ne podle názvů: název kamery jde
  -- přejmenovat, štítek na krabici ne.
  UPDATE cameras SET zone_id = v_jz
   WHERE site_id = v_site AND serial_number IN ('CAM-VV-01', 'CAM-VV-05');

  UPDATE cameras SET zone_id = v_sv
   WHERE site_id = v_site AND serial_number IN ('CAM-VV-02', 'CAM-VV-03', 'CAM-VV-04');

  -- Waypoint = těžiště kamer zóny. ST_Centroid pracuje s geometry,
  -- proto tam a zpět; na dvou stech metrech je zkreslení zanedbatelné.
  UPDATE zones z
     SET location = sub.center
    FROM (
      SELECT c.zone_id,
             ST_SetSRID(ST_Centroid(ST_Collect(c.location::geometry)), 4326)::geography AS center
        FROM cameras c
       WHERE c.site_id = v_site AND c.zone_id IS NOT NULL AND c.location IS NOT NULL
       GROUP BY c.zone_id
    ) sub
   WHERE z.id = sub.zone_id;

  SELECT count(*) INTO v_bez
    FROM cameras WHERE site_id = v_site AND zone_id IS NULL;

  IF v_bez > 0 THEN
    RAISE WARNING 'Na Vysokém Veselí zůstává % kamer bez zóny — ty zásah nespustí.', v_bez;
  ELSE
    RAISE NOTICE 'Všechny kamery na Vysokém Veselí mají zónu.';
  END IF;
END $$;
