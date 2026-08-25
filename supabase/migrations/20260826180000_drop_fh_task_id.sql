-- ═══════════════════════════════════════════════════════════════════
-- flights.fh_task_id byl odhad z prvního schématu — nikdy se neplnil.
-- Skutečné UUID úlohy z FlightHubu nese fh_task_uuid, přidané migrací
-- 20260826120000 spolu s hlídkami.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- Pojistka: kdyby sloupec přece jen někde data měl, migrace se
-- zastaví a data zůstanou. Zahazovat se má prázdný sloupec, ne
-- historie letů.
DO $$
DECLARE v_filled BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flights'
      AND column_name = 'fh_task_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM flights WHERE fh_task_id IS NOT NULL'
      INTO v_filled;
    IF v_filled > 0 THEN
      RAISE EXCEPTION
        'flights.fh_task_id má % vyplněných hodnot — přeneste je do '
        'fh_task_uuid a migraci spusťte znovu.', v_filled;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_flights_fh_task_id;
ALTER TABLE flights DROP COLUMN IF EXISTS fh_task_id;
