-- ═══════════════════════════════════════════════════════════════════
-- Kamera dostává místo a směr.
--
-- Doteď se vědělo jen, kterou zónu kamera hlídá. Pro podklad areálu
-- je potřeba i bod a natočení, aby šlo vykreslit výseč záběru a bylo
-- vidět, kudy je díra v pokrytí.
--
-- Zorný úhel se neukládá — dopočítává se z focal_mm, aby nešly ta dvě
-- čísla rozejít. Tabulku ohnisek drží src/lib/area-map.ts.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS location geography(Point, 4326);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS azimuth SMALLINT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS range_m SMALLINT NOT NULL DEFAULT 30;

COMMENT ON COLUMN cameras.azimuth IS
  'Kam kamera kouká, ve stupních. 0 sever, 90 východ. NULL = po montáži '
  'nezměřeno; na podkladu areálu se pak kreslí jen bod bez výseče.';
COMMENT ON COLUMN cameras.range_m IS
  'Dosah záběru v metrech. Jen pro vykreslení výseče, detekci neomezuje.';

-- 360 = 0, jinak by šly do databáze dva zápisy téhož směru.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_azimuth_range;
ALTER TABLE cameras ADD CONSTRAINT cameras_azimuth_range CHECK (
  azimuth IS NULL OR (azimuth >= 0 AND azimuth <= 359)
);

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_range_m_positive;
ALTER TABLE cameras ADD CONSTRAINT cameras_range_m_positive CHECK (
  range_m > 0 AND range_m <= 1000
);

CREATE INDEX IF NOT EXISTS idx_cameras_location ON cameras USING GIST (location);
