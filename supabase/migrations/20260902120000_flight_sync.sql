-- ═══════════════════════════════════════════════════════════════════
-- Vrstva na tahání dat z DJI FlightHubu.
--
-- Většina sloupců, které synchronizace potřebuje, ve schématu už je
-- (started_at, ended_at, duration_s, distance_m, trajectory, status
-- u letů; flight_id, kind, r2_key, captured_at, size_bytes, meta
-- u médií). Tahle migrace doplňuje jen to, co chybí, a zakládá
-- úložiště.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Stav úlohy tak, jak ho hlásí DJI ─────────────────────────────
--
-- flights.status je NÁŠ enum o pěti hodnotách. DJI jich má osm
-- (waiting, starting_failure, executing, paused, terminated, success,
-- suspended, timeout) a mapují se na náš enum ztrátově — „paused“
-- i „executing“ jsou u nás obojí 'in_progress'. Původní hodnota se
-- proto ukládá vedle: bez ní by po nasazení nešlo zjistit, jestli
-- let skončil úspěchem, vypršel, nebo ho někdo přerušil.
ALTER TABLE flights ADD COLUMN IF NOT EXISTS fh_status TEXT;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

COMMENT ON COLUMN flights.fh_status IS
  'Stav úlohy doslova z FlightHubu (GET /flight-task/{uuid}.data.status). '
  'Náš flights.status je jeho zjednodušení.';
COMMENT ON COLUMN flights.synced_at IS
  'Kdy se let naposledy dotahoval. NULL = ještě nikdy.';

-- Synchronizace bere lety, které mají úlohu a nemají konec. Bez
-- tohohle indexu by to byl seq scan přes celou tabulku pokaždé.
CREATE INDEX IF NOT EXISTS idx_flights_sync_pending
  ON flights(fh_task_uuid)
  WHERE fh_task_uuid IS NOT NULL AND ended_at IS NULL;

-- ── Médium z FlightHubu ──────────────────────────────────────────

ALTER TABLE media ADD COLUMN IF NOT EXISTS fh_media_id TEXT;

COMMENT ON COLUMN media.fh_media_id IS
  'UUID souboru ve FlightHubu (GET /flight-task/{uuid}/media → '
  'data.list[].uuid). Na tomhle stojí idempotence: co už tu je, '
  'se nestahuje podruhé.';

-- Jádro idempotence. Bez něj by druhý běh synchronizace stáhl táž
-- videa znovu — a u médií z dronu to nejsou kilobajty.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_fh_media_id
  ON media(fh_media_id) WHERE fh_media_id IS NOT NULL;

COMMENT ON COLUMN media.r2_key IS
  'Klíč objektu v privátním úložišti, ne veřejná URL. Dnes je to cesta '
  'v bucketu `lety`; jméno sloupce je z doby, kdy se počítalo s R2.';

-- ── Úložiště médií ───────────────────────────────────────────────
-- Stejný vzor jako u vjezdů: privátní bucket, první složka v cestě je
-- UUID lokality, takže čtení pouští táž funkce jako u řádků. Na
-- záznamech z dronu je cizí pozemek a lidé na něm; veřejný bucket
-- nepřipadá v úvahu.
--
-- Podmíněné existencí schématu `storage` — v lokální testovací
-- databázi neexistuje.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE 'Schéma storage neexistuje (lokální databáze) — přeskakuji.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('lety', 'lety', FALSE, 512 * 1024 * 1024,
          ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'])
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  EXECUTE 'DROP POLICY IF EXISTS "lety_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "lety_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'lety'
        AND public.site_is_visible(((storage.foldername(name))[1])::uuid)
      )
  $pol$;

  -- Zápis nikomu z přihlášených: nahrává synchronizace pod service_role.
  EXECUTE 'DROP POLICY IF EXISTS "lety_write" ON storage.objects';

  RAISE NOTICE 'Bucket lety je připravený.';
END $$;
