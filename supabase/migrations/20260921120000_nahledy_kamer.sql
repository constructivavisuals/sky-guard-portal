-- ═══════════════════════════════════════════════════════════════════
-- Náhledy kamer — jeden statický snímek na kameru.
--
-- V seznamu /kamery byla u každého řádku jen ikona, takže se kamery
-- rozlišovaly podle jména (KL_01 … KL_06). Kdo nechodí po stavbě, z toho
-- nepozná, která kouká na vjezd a která na jeřáb, a otevírá je po řadě.
--
-- Živá mřížka to neřeší (proč, viz komentář v page.tsx): devět spojení
-- naráz na kamery, které zároveň píšou na kartu. Tohle je opak —
-- JEDEN snímek, obnovovaný cronem jednou týdně.
--
-- ═══ Proč privátní bucket ══════════════════════════════════════════
-- Je to obraz z cizí stavby, tedy totéž co snímek u detekce: veřejný
-- bucket by znamenal, že kdo uhodne adresu, vidí na pozemek. Stejný
-- vzor jako `detekce` a `vjezdy` — první složka v cestě je UUID
-- lokality a čtení pouští táž funkce jako u řádků.
--
-- ═══ Proč sloupce, a ne jen soubor na odhadnutelné cestě ═══════════
-- `preview_captured_at` je to, čím se náhled u klienta POPÍŠE. Statický
-- snímek bez data vypadá jako živý obraz a tvrdil by o stavbě něco,
-- co nemusí platit — třeba že tam ještě stojí bagr, který odjel
-- v úterý. Datum z něj dělá náhled, ne výhled z okna.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS preview_path text,
  ADD COLUMN IF NOT EXISTS preview_captured_at timestamptz;

COMMENT ON COLUMN cameras.preview_path IS
  'Cesta náhledu v privátním bucketu `nahledy` (`<site_id>/<camera_id>.jpg`), '
  'ne URL. NULL = náhled se ještě nepodařilo pořídit.';

COMMENT ON COLUMN cameras.preview_captured_at IS
  'Kdy snímek vznikl. Ukazuje se u náhledu v seznamu kamer — statický '
  'obraz bez data by se dal splést s živým.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE 'Schéma storage neexistuje (lokální databáze) — přeskakuji.';
    RETURN;
  END IF;

  -- Strop 2 MB je s rezervou: cron ukládá JPEG zmenšený na 640 px,
  -- což vychází na desítky kilobajtů. Limit je tu proti omylu, ne
  -- proti běžnému provozu.
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('nahledy', 'nahledy', FALSE, 2 * 1024 * 1024, ARRAY['image/jpeg'])
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  EXECUTE 'DROP POLICY IF EXISTS "nahledy_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "nahledy_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'nahledy'
        AND public.site_is_visible(((storage.foldername(name))[1])::uuid)
      )
  $pol$;

  -- Zápis nikomu z přihlášených: náhledy nahrává cron pod service_role.
  EXECUTE 'DROP POLICY IF EXISTS "nahledy_write" ON storage.objects';

  RAISE NOTICE 'Bucket nahledy je připravený.';
END $$;

-- Ověření po nasazení:
--
--   SELECT id, name, preview_path, preview_captured_at FROM cameras;
--
-- Po prvním běhu /api/cron/nahledy má mít každá kamera s sériovým
-- číslem vyplněnou cestu i čas.
