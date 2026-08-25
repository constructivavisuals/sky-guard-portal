-- ═══════════════════════════════════════════════════════════════════
-- Dvě věci najednou, obě o tom, aby se dalo dohledat, co se stalo.
--
-- 1) dispatches.decision_reason — dosud si databáze ukládala jen
--    výsledek (outcome) a stupeň (level_sent), ne důvod. Detail zásahu
--    ho proto dopočítával zpětně ze stejných pravidel jako ingest, což
--    znamená, že po každé změně pravidel by staré zásahy vyprávěly
--    novou verzi minulosti. Teď se důvod zapisuje.
--
-- 2) detections mohou vzniknout i za letu dronu. Detekce se tím
--    odvazuje od kamery: camera_id je volitelné, přibývá flight_id
--    a source rozhoduje, které z nich je povinné.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── 1) Důvod rozhodnutí u zásahu ─────────────────────────────────

ALTER TABLE dispatches
  ADD COLUMN IF NOT EXISTS decision_reason JSONB;

COMMENT ON COLUMN dispatches.decision_reason IS
  'Podle čeho ingest rozhodl: base_level, escalated, armed, cooldown. '
  'NULL u záznamů z doby před touto migrací — UI je pozná a označí '
  'jako rekonstrukci.';

-- Schválně bez DEFAULT '{}': prázdný objekt by se nedal odlišit od
-- záznamu, u kterého se důvod opravdu zapsal.

-- ── 2) Detekce z dronu ───────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE detection_source AS ENUM ('camera', 'drone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DEFAULT 'camera' zároveň doplní všechny stávající řádky.
ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS source detection_source NOT NULL DEFAULT 'camera';

ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS flight_id UUID;

-- FK zvlášť, ať se ADD COLUMN IF NOT EXISTS nezacyklí na opakovaném běhu.
ALTER TABLE detections DROP CONSTRAINT IF EXISTS detections_flight_id_fkey;
ALTER TABLE detections ADD CONSTRAINT detections_flight_id_fkey
  FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE RESTRICT;

-- Kamera už není povinná — dronová detekce žádnou nemá.
ALTER TABLE detections ALTER COLUMN camera_id DROP NOT NULL;

-- Co je povinné, určuje zdroj. Bez tohohle by šlo uložit detekci,
-- která nepatří ani kameře, ani letu, a nikdo by nedohledal odkud je.
ALTER TABLE detections DROP CONSTRAINT IF EXISTS detections_source_requires_origin;
ALTER TABLE detections ADD CONSTRAINT detections_source_requires_origin CHECK (
  (source = 'camera' AND camera_id IS NOT NULL)
  OR (source = 'drone' AND flight_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_detections_flight_time
  ON detections(flight_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_source ON detections(source);

-- ── RLS: viditelnost podle toho, odkud detekce je ────────────────
-- Kamerová jde přes lokalitu kamery, dronová přes viditelnost letu.
-- camera_site_id() vrátí u NULL vstupu NULL a site_is_visible(NULL)
-- vrací false, takže bez téhle úpravy by dronové detekce neviděl nikdo.

DROP POLICY IF EXISTS "read_detections" ON detections;
CREATE POLICY "read_detections" ON detections
  FOR SELECT TO authenticated
  USING (
    (camera_id IS NOT NULL AND site_is_visible(camera_site_id(camera_id)))
    OR (flight_id IS NOT NULL AND flight_is_visible(flight_id))
  );

DROP POLICY IF EXISTS "write_detections" ON detections;
CREATE POLICY "write_detections" ON detections
  FOR ALL TO authenticated
  USING (
    (camera_id IS NOT NULL AND site_is_manager(camera_site_id(camera_id)))
    OR (flight_id IS NOT NULL AND is_admin())
  )
  WITH CHECK (
    (camera_id IS NOT NULL AND site_is_manager(camera_site_id(camera_id)))
    OR (flight_id IS NOT NULL AND is_admin())
  );
