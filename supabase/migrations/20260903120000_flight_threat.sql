-- ═══════════════════════════════════════════════════════════════════
-- Potvrzení nebezpečí z fotek letu.
--
-- Po dokončení letu projdou pořízené fotky modelem s jedinou otázkou:
-- je na nich člověk nebo vozidlo? Odpověď je tříhodnotová a NULL není
-- „ne“:
--
--   TRUE   dron to na snímcích našel
--   FALSE  prošel všechny snímky a nenašel nic
--   NULL   nejistý výsledek, nebo se ptát nebylo na co
--
-- Stejný vzor jako u SPZ: pod prahem jistoty se výsledek zahazuje,
-- protože „model si myslí, že tam asi nikdo není“ je horší než přiznané
-- „nevíme“ — na tohle se kouká člověk a musí poznat, kdy se má
-- podívat sám.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE flights ADD COLUMN IF NOT EXISTS threat_confirmed BOOLEAN;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS threat_note TEXT;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS threat_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN flights.threat_confirmed IS
  'Našel model na fotkách z letu člověka nebo vozidlo? NULL = nejistý '
  'výsledek nebo nebylo z čeho číst, NE „nic tam není“ — od toho je FALSE.';
COMMENT ON COLUMN flights.threat_note IS
  'Věta pro člověka: na kolika snímcích to model našel a co viděl.';
COMMENT ON COLUMN flights.threat_checked_at IS
  'Kdy kontrola proběhla. NULL = ještě neproběhla. Bez tohohle sloupce '
  'by NULL v threat_confirmed znamenalo obojí — „nejisté“ i „neptali '
  'jsme se“ — a v UI by to nešlo odlišit.';

-- Synchronizace bere dokončené lety, u kterých kontrola ještě
-- neproběhla. Bez indexu by to byl seq scan přes celou tabulku
-- v každém běhu cronu.
CREATE INDEX IF NOT EXISTS idx_flights_threat_pending
  ON flights(ended_at)
  WHERE ended_at IS NOT NULL AND threat_checked_at IS NULL;
