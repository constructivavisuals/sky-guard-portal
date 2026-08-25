-- ═══════════════════════════════════════════════════════════════════
-- Statický podklad areálu.
--
-- Místo dlaždic z mapového serveru drží lokalita jeden obrázek a dva
-- rohy. Body se na něj promítají lineárně z rozsahu souřadnic — na
-- ploše dvou set metrů je zkreslení zanedbatelné a odpadá závislost
-- na externí mapě, která by u bezpečnostního systému znamenala další
-- venkovní volání při každém zobrazení.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_image_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_nw_lat DOUBLE PRECISION;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_nw_lon DOUBLE PRECISION;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_se_lat DOUBLE PRECISION;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_se_lon DOUBLE PRECISION;

COMMENT ON COLUMN sites.map_image_url IS
  'Podklad areálu. Cesta v public/ nebo absolutní URL. Obrázek se do '
  'rámečku roztahuje (object-fit: fill), takže jeho vlastní poměr stran '
  'nemusí odpovídat výřezu — rohy určují souřadnicový rozsah, ne ořez.';

-- Rohy dávají smysl jen v úplné čtveřici; polovina by tiše rozbila
-- projekci a body by skončily mimo.
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_map_bounds_complete;
ALTER TABLE sites ADD CONSTRAINT sites_map_bounds_complete CHECK (
  (map_nw_lat IS NULL AND map_nw_lon IS NULL
   AND map_se_lat IS NULL AND map_se_lon IS NULL)
  OR (map_nw_lat IS NOT NULL AND map_nw_lon IS NOT NULL
      AND map_se_lat IS NOT NULL AND map_se_lon IS NOT NULL)
);

-- Nulový rozsah by při promítání dělil nulou.
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_map_bounds_span;
ALTER TABLE sites ADD CONSTRAINT sites_map_bounds_span CHECK (
  map_nw_lat IS NULL
  OR (map_nw_lat <> map_se_lat AND map_nw_lon <> map_se_lon)
);

-- ── Vysoké Veselí ────────────────────────────────────────────────
-- Data, ne schéma. Když se lokalita jmenuje jinak nebo ještě
-- neexistuje, migrace to řekne a jinak nic neudělá.

DO $$
DECLARE v_updated BIGINT;
BEGIN
  UPDATE sites
     SET map_image_url = '/mapa-vysoke-veseli.jpg',
         map_nw_lat = 50.331201,
         map_nw_lon = 15.424061,
         map_se_lat = 50.329457,
         map_se_lon = 15.427197
   WHERE name ILIKE '%vysoké veselí%'
     AND map_image_url IS DISTINCT FROM '/mapa-vysoke-veseli.jpg';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE NOTICE 'Lokalita Vysoké Veselí nenalezena nebo už podklad má — '
                 'rohy doplňte ručně přes formulář lokality.';
  ELSE
    RAISE NOTICE 'Podklad doplněn u % lokalit.', v_updated;
  END IF;
END $$;
