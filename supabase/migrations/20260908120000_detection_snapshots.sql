-- ═══════════════════════════════════════════════════════════════════
-- Snímky u detekcí.
--
-- Sloupec detections.storage_path je ve schématu od první migrace, ale
-- nikdy nebyl kam ukládat: ingest detekce snímek nepřijímal a bucket
-- neexistoval. Detekce osoby — tedy ta vážnější událost — po sobě
-- nechávala jen čas a jistotu, takže planý poplach nešlo ověřit.
--
-- Stejný vzor jako u vjezdů: privátní bucket, první složka v cestě je
-- UUID lokality, čtení pouští táž funkce jako u řádků.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE 'Schéma storage neexistuje (lokální databáze) — přeskakuji.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('detekce', 'detekce', FALSE, 4 * 1024 * 1024,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  EXECUTE 'DROP POLICY IF EXISTS "detekce_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "detekce_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'detekce'
        AND public.site_is_visible(((storage.foldername(name))[1])::uuid)
      )
  $pol$;

  -- Zápis nikomu z přihlášených: snímky nahrává ingest pod service_role.
  EXECUTE 'DROP POLICY IF EXISTS "detekce_write" ON storage.objects';

  RAISE NOTICE 'Bucket detekce je připravený.';
END $$;

COMMENT ON COLUMN detections.storage_path IS
  'Cesta snímku v privátním bucketu `detekce`, ne URL. NULL u dronových '
  'detekcí a u kamer, které snímek neposílají.';
