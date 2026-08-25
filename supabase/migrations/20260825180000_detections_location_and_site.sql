-- ═══════════════════════════════════════════════════════════════════
-- Úklid dvou dluhů z minulé migrace.
--
-- 1) Poloha dronové detekce se dosud četla z raw jsonb. Fungovalo to
--    pro zobrazení, ale nešlo se na ni ptát prostorově — teď má vlastní
--    sloupec geography s GIST indexem.
--
-- 2) Detekce neznala svou lokalitu. Kamerová ji měla přes kameru,
--    dronová přes let a jeho zásah, takže /detekce musela filtrovat až
--    po načtení a RLS měla dvě větve. site_id to obojí ruší.
--
-- POZOR na změnu chování: dronová detekce z letu bez zásahu byla dosud
-- viditelná jen adminovi, protože flight_is_visible() u letu bez
-- lokality spadne na is_admin(). Se site_id se řídí lokalitou jako
-- všechno ostatní — kdo má na lokalitu grant, uvidí ji. Je to důsledek
-- toho, že detekce teď svou lokalitu zná.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── 1) Poloha detekce ────────────────────────────────────────────

ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

COMMENT ON COLUMN detections.location IS
  'Kde detekce vznikla. Vyplněné u dronových (z telemetrie), '
  'u kamerových zůstává prázdné — polohu nese zóna.';

-- Doplnění stávajících dronových řádků ze syrových dat. Rozsah se
-- kontroluje tady, ne až v aplikaci: nesmyslná telemetrie by jinak
-- skončila v indexu jako platný bod.
UPDATE detections
   SET location = ST_SetSRID(
         ST_MakePoint(
           (raw->>'longitude')::double precision,
           (raw->>'latitude')::double precision
         ), 4326)::geography
 WHERE source = 'drone'
   AND location IS NULL
   AND jsonb_typeof(raw->'latitude') = 'number'
   AND jsonb_typeof(raw->'longitude') = 'number'
   AND (raw->>'latitude')::double precision BETWEEN -90 AND 90
   AND (raw->>'longitude')::double precision BETWEEN -180 AND 180;

CREATE INDEX IF NOT EXISTS idx_detections_location
  ON detections USING GIST (location);

-- ── 2) Lokalita detekce ──────────────────────────────────────────

ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE RESTRICT;

-- Kamerová detekce: přes kameru.
UPDATE detections d
   SET site_id = c.site_id
  FROM cameras c
 WHERE d.site_id IS NULL
   AND d.camera_id = c.id;

-- Dronová detekce: přes let a jeho zásah.
UPDATE detections d
   SET site_id = p.site_id
  FROM flights f
  JOIN dispatches p ON p.id = f.dispatch_id
 WHERE d.site_id IS NULL
   AND d.flight_id = f.id;

-- Zbytek odvodit nejde: dronová detekce z letu, který nevisí na žádném
-- zásahu, nemá odkud lokalitu vzít — flights sloupec site_id nemají.
-- Migrace v takovém případě spadne, ať se to řeší vědomě, místo aby
-- NOT NULL selhalo o řádek níž s nesrozumitelnou hláškou.
DO $$
DECLARE v_orphans BIGINT;
BEGIN
  SELECT count(*) INTO v_orphans FROM detections WHERE site_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'U % detekcí nejde odvodit lokalita (dronové z letu bez zásahu). '
      'Doplňte jim site_id ručně a migraci spusťte znovu.', v_orphans;
  END IF;
END $$;

ALTER TABLE detections ALTER COLUMN site_id SET NOT NULL;

-- Hlavní dotaz seznamu: detekce lokality, nejnovější první.
CREATE INDEX IF NOT EXISTS idx_detections_site_time
  ON detections(site_id, detected_at DESC);

-- ── 3) RLS jednou větví ──────────────────────────────────────────
-- Detekce teď svou lokalitu zná, takže se ptá stejně jako zóny,
-- kamery i zásahy. Průchod přes camera_site_id() ani flight_is_visible()
-- už není potřeba.

DROP POLICY IF EXISTS "read_detections" ON detections;
CREATE POLICY "read_detections" ON detections
  FOR SELECT TO authenticated
  USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "write_detections" ON detections;
CREATE POLICY "write_detections" ON detections
  FOR ALL TO authenticated
  USING (site_is_manager(site_id))
  WITH CHECK (site_is_manager(site_id));
