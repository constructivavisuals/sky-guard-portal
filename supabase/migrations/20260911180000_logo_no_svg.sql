-- ═══════════════════════════════════════════════════════════════════
-- SVG ven z veřejného bucketu s logy.
--
-- Bucket `loga` je jediný veřejný: logo klienta se ukazuje v hlavičce
-- portálu a vkládá se do PDF reportu, kde podepsaná adresa nepomůže
-- (report si ho tahá server, ale prohlížeč z hlavičky ne). To je
-- vědomé rozhodnutí a zůstává.
--
-- Co zůstat nemůže, je SVG. Je to spustitelný dokument, ne obrázek:
-- nese <script>, umí načítat cizí zdroje a otevřít se dá přímo, mimo
-- portál, na doméně Supabase. Adresa je přitom veřejná a platí navždy.
-- Riziko je malé (nahrává jen admin), ale cena za jeho odstranění je
-- jeden řádek — a logo ve formátu PNG nebo WebP vypadá stejně.
--
-- Případná už nahraná SVG se NEMAŽOU: soubor by zmizel a klientovi by
-- se rozbila hlavička. Migrace jen zakáže nová a vypíše, kterých
-- profilů se to týká, aby šlo logo vyměnit ručně.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$
DECLARE v_svg TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE 'Schéma storage neexistuje (lokální databáze) — přeskakuji.';
    RETURN;
  END IF;

  UPDATE storage.buckets
     SET allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']
   WHERE id = 'loga';

  SELECT string_agg(logo_path, ', ') INTO v_svg
    FROM profiles WHERE logo_path LIKE '%.svg';

  IF v_svg IS NOT NULL THEN
    RAISE WARNING 'Nahraná SVG loga zůstávají a je potřeba je vyměnit ručně: %', v_svg;
  ELSE
    RAISE NOTICE 'Žádné SVG logo v profilech není.';
  END IF;
END $$;
