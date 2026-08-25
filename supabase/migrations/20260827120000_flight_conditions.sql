-- ═══════════════════════════════════════════════════════════════════
-- Podmínky, za kterých byl let naplánovaný.
--
-- Dok hlásí vítr, srážky a teplotu. Ukládají se k letu, aby šlo zpětně
-- dohledat, za jakého počasí se letělo — u přerušeného letu je to první
-- věc, na kterou se člověk ptá.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE flights
  ADD COLUMN IF NOT EXISTS conditions JSONB;

COMMENT ON COLUMN flights.conditions IS
  'Odečet z doku v okamžiku plánování: wind_speed, rainfall, '
  'environment_temperature. NULL, když dok hodnoty nehlásil nebo když '
  'let nevznikl z hlídky.';
