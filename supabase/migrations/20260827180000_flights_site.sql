-- ═══════════════════════════════════════════════════════════════════
-- Lokalita letu.
--
-- Let ji dosud znal jen oklikou: hlídkový přes hlídku, zásahový přes
-- zásah. Filtrovat podle lokality by tím pádem šlo až po načtení, což
-- rozbíjí stránkování — přesně ta chyba, kterou jsme u detekcí
-- odstranili migrací 20260825180000.
--
-- Sloupec je nullable schválně: let bez zásahu i bez hlídky (ruční mise
-- spuštěná přímo z FlightHubu) lokalitu odvodit nemá odkud.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE flights
  ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE RESTRICT;

COMMENT ON COLUMN flights.site_id IS
  'Lokalita letu. NULL u ručních misí mimo portál, které nevisí ani na '
  'zásahu, ani na hlídce.';

-- Hlídkový let: přes hlídku.
UPDATE flights f
   SET site_id = p.site_id
  FROM patrols p
 WHERE f.site_id IS NULL AND f.patrol_id = p.id;

-- Zásahový let: přes zásah.
UPDATE flights f
   SET site_id = d.site_id
  FROM dispatches d
 WHERE f.site_id IS NULL AND f.dispatch_id = d.id;

CREATE INDEX IF NOT EXISTS idx_flights_site_time
  ON flights(site_id, started_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────
-- Rozšíření, ne náhrada. Hlídkové lety nevisí na žádném zásahu, takže
-- flight_is_visible() u nich spadne na is_admin() a nikdo jiný by je
-- neviděl. Původní větev zůstává, aby se nezměnilo chování letů bez
-- lokality — ty vidí dál jen admin.

DROP POLICY IF EXISTS "read_flights" ON flights;
CREATE POLICY "read_flights" ON flights
  FOR SELECT TO authenticated
  USING (
    (site_id IS NOT NULL AND site_is_visible(site_id))
    OR flight_is_visible(id)
  );
