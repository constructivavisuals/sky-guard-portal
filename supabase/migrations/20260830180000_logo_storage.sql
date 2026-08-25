-- ═══════════════════════════════════════════════════════════════════
-- Úložiště pro loga klientů.
--
-- Bucket je VEŘEJNÝ. Logo je marketingový podklad, ne citlivý údaj,
-- a veřejné čtení ušetří podepisování URL při každém vykreslení
-- postranního panelu — což je síťové volání na každé načtení stránky.
-- Zapisovat smí jen admin, to hlídají politiky níž.
--
-- Celý soubor je podmíněný existencí schématu `storage`: na produkci
-- ho zakládá Supabase, v lokální testovací databázi neexistuje a bez
-- téhle podmínky by tam migrace spadla.
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

  -- ── Bucket ────────────────────────────────────────────────────
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'loga', 'loga', TRUE,
    2 * 1024 * 1024,
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
  )
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  -- ── Politiky ──────────────────────────────────────────────────
  -- Čtení je veřejné (bucket je public), zápis jen adminovi. Politiky
  -- se zakládají dynamicky, protože CREATE POLICY nemá IF NOT EXISTS.

  EXECUTE 'DROP POLICY IF EXISTS "loga_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "loga_read" ON storage.objects
      FOR SELECT TO public
      USING (bucket_id = 'loga')
  $pol$;

  EXECUTE 'DROP POLICY IF EXISTS "loga_write" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "loga_write" ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'loga' AND public.is_admin())
      WITH CHECK (bucket_id = 'loga' AND public.is_admin())
  $pol$;

  RAISE NOTICE 'Bucket loga je připravený.';
END $$;
