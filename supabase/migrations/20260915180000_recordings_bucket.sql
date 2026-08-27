-- ═══════════════════════════════════════════════════════════════════
-- Bucket pro záznamy ze stavebních kamer.
--
-- Čtvrtý privátní bucket a přesně týž vzor jako u tří předchozích:
-- první složka v cestě je UUID lokality a čtení pouští táž funkce jako
-- u řádků. Kdo na lokalitu nevidí, nedostane ani podepsanou adresu.
--
-- ═══ Proč ne R2 ════════════════════════════════════════════════════
-- Zvažovalo se, protože constructiva-portal tam kamerová data má.
-- Objemový argument ale byl časosběr (statisíce snímků, žádná lhůta)
-- a ten do Sky Guardu nejde. Zbývá video se čtrnáctidenní lhůtou, a to
-- druhé úložiště nezaplatí: přineslo by druhou autorizační cestu, další
-- strom závislostí a hlavně přihlašovací údaje na cizím serveru, které
-- se nedají zúžit — Supabase S3 klíč platí na všechny buckety a obchází
-- RLS.
--
-- Jedno úložiště, jedna autorizace.
--
-- ═══ Kdo sem zapisuje ══════════════════════════════════════════════
-- Nikdo z přihlášených. Relay soubor nahrává na JEDNORÁZOVOU podepsanou
-- adresu, kterou mu vystaví portál — na úložiště ani do databáze sám
-- nesahá. Zápisová politika by tedy byla právo, které nikdo nepoužívá.
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

  -- Strop na soubor: minutový úsek z kamery má jednotky až desítky MB.
  -- 256 MB je s rezervou dost a zároveň zastaví omyl, kterým by někdo
  -- poslal celou hodinu v nativním rozlišení.
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('zaznamy', 'zaznamy', FALSE, 256 * 1024 * 1024,
          ARRAY['video/mp4', 'video/quicktime'])
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  EXECUTE 'DROP POLICY IF EXISTS "zaznamy_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "zaznamy_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'zaznamy'
        AND public.site_is_visible(((storage.foldername(name))[1])::uuid)
      )
  $pol$;

  -- Zápis nikomu z přihlášených: nahrává relay na podepsanou adresu.
  EXECUTE 'DROP POLICY IF EXISTS "zaznamy_write" ON storage.objects';

  RAISE NOTICE 'Bucket zaznamy je připravený.';
END $$;
