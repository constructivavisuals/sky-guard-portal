-- ═══════════════════════════════════════════════════════════════════
-- Sjednocení názvu sloupce s cestou v úložišti.
--
-- Sloupce vznikly v době, kdy se počítalo s Cloudflare R2. Skončilo to
-- u Supabase Storage a jméno `r2_key` od té doby lhalo — komentář
-- „ve skutečnosti Supabase“ je horší než přejmenování, protože ho
-- při čtení kódu nikdo nevidí.
--
-- Všude teď `storage_path`: cesta v privátním bucketu, ne URL.
--
--   media.r2_key                → media.storage_path
--   detections.snapshot_r2_key  → detections.storage_path
--   vehicle_passages.image_path → vehicle_passages.storage_path
--
-- Tabulky jsou zatím prázdné, takže přejmenování nic nestojí. Data by
-- ho stejně přežila — ALTER ... RENAME COLUMN je jen změna katalogu.
--
-- Idempotentní: bezpečné spustit víckrát. Každé přejmenování se dělá,
-- jen když starý sloupec ještě existuje a nový ne; při druhém běhu
-- neudělá nic.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('media',             'r2_key',           'storage_path'),
      ('detections',        'snapshot_r2_key',  'storage_path'),
      ('vehicle_passages',  'image_path',       'storage_path')
    ) AS t(tabulka, stary, novy)
  LOOP
    -- Tabulka nemusí existovat: vehicle_passages zakládá až migrace
    -- 20260901120000 a pořadí spouštění nemá být na čem záviset.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = r.tabulka
    ) THEN
      RAISE NOTICE 'Tabulka % neexistuje — přeskakuji.', r.tabulka;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.tabulka
         AND column_name = r.novy
    ) THEN
      RAISE NOTICE '%.% už existuje — přeskakuji.', r.tabulka, r.novy;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.tabulka
         AND column_name = r.stary
    ) THEN
      RAISE NOTICE '%.% neexistuje — není co přejmenovat.', r.tabulka, r.stary;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I',
                   r.tabulka, r.stary, r.novy);
    RAISE NOTICE 'Přejmenováno %.% → %', r.tabulka, r.stary, r.novy;
  END LOOP;
END $$;

-- Index se přejmenoval s tabulkou jen co do definice, ne co do jména.
-- Nechat ho jako idx_media_r2_key by znamenalo, že po sloupci zůstane
-- v schématu druhá lež.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_media_r2_key') THEN
    ALTER INDEX idx_media_r2_key RENAME TO idx_media_storage_path;
    RAISE NOTICE 'Index přejmenován na idx_media_storage_path.';
  END IF;
END $$;

-- Popisky až nakonec a podmíněně: COMMENT ON neexistujícím sloupci
-- je chyba, ne no-op, a shodil by celou migraci u toho, kdo ji pustí
-- dřív než 20260901120000.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('media', 'Cesta souboru v privátním bucketu `lety`, ne URL. Adresa se skládá až při vykreslení a podepisuje se.'),
      ('detections', 'Cesta snímku detekce v úložišti, ne URL.'),
      ('vehicle_passages', 'Cesta snímku od brány v bucketu `vjezdy`, ne URL.')
    ) AS t(tabulka, popis)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = r.tabulka
         AND column_name = 'storage_path'
    ) THEN
      EXECUTE format('COMMENT ON COLUMN %I.storage_path IS %L', r.tabulka, r.popis);
    END IF;
  END LOOP;
END $$;
