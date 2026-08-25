-- ═══════════════════════════════════════════════════════════════════
-- Evidence vjezdů: čtení SPZ a seznam známých značek.
--
-- Převzato z constructiva-portal (vehicle_detections + known_plates),
-- přizpůsobeno našemu modelu: lokalita se drží přímo, ne přes
-- camera_sites, a vjezd visí na detekci.
--
-- ═══ Proč na detekci ═══════════════════════════════════════════════
-- Vjezd JE detekce vozidla. Ingest zakládá řádek v detections
-- (object_class 'vehicle') a teprve k němu vjezd s obrázkem a značkou.
-- Tím projde rozhodnutí o zásahu beze změny stávající cestou —
-- BASE_LEVEL_BY_CLASS má vehicle na stupni 2 — a nemusí čekat na
-- přečtení značky, které trvá vteřiny. SPZ dorazí jako doplněk
-- a případnou eskalaci na stupeň osoby řeší až ona.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Normalizace značky ───────────────────────────────────────────
-- IMMUTABLE, protože z ní staví funkční index níž. Protějšek
-- normalizePlate() v src/lib/plates.ts; shodu obou hlídá paritní test
-- v supabase/tests/run-local.sh, stejně jako u site_is_armed().

CREATE OR REPLACE FUNCTION plate_normalize(p_plate TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT upper(regexp_replace(p_plate, '[^a-zA-Z0-9]', '', 'g'));
$$;

COMMENT ON FUNCTION plate_normalize(TEXT) IS
  'SPZ bez mezer, pomlček a malých písmen — porovnávací tvar. '
  'Protějšek normalizePlate() v src/lib/plates.ts.';

-- ── known_plates ─────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE plate_list_type AS ENUM ('allow', 'deny');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS known_plates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Ukládá se tak, jak ji člověk napsal — kvůli čitelnosti v seznamu.
  -- Porovnává se přes plate_normalize().
  plate TEXT NOT NULL CHECK (length(trim(plate)) > 0),
  label TEXT,
  list_type plate_list_type NOT NULL DEFAULT 'allow',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Jedna značka jednou na lokalitu, bez ohledu na zápis mezer a pomlček.
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_plates_site_plate
  ON known_plates(site_id, plate_normalize(plate));
CREATE INDEX IF NOT EXISTS idx_known_plates_site ON known_plates(site_id);

COMMENT ON TABLE known_plates IS
  'Seznam značek na lokalitu: allow = smí sem, deny = nežádoucí. '
  'Značka mimo seznam je neznámá a v ostrém režimu vede na zásah.';

-- ── vehicle_passages ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicle_passages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  camera_id UUID REFERENCES cameras(id) ON DELETE SET NULL,
  -- Detekce, ze které vjezd vznikl. Přes ni vede vazba na zásah.
  detection_id UUID NOT NULL REFERENCES detections(id) ON DELETE CASCADE,

  -- NULL = značka ještě nepřečtená nebo nečitelná. Řádek vzniká
  -- v obou případech; je to záznam „tohle už jsme zkoušeli“.
  plate TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- Snímek v bucketu `vjezdy`; cesta, ne URL.
  image_path TEXT,

  -- Jak vjezd dopadl proti seznamu, ROZHODNUTO V DOBĚ VJEZDU. Uloženo,
  -- ne dopočítáváno: seznam se mění a starý vjezd by po každé úpravě
  -- vyprávěl jinou verzi, stejně jako dispatches.decision_reason.
  list_match plate_list_type,
  known_plate_id UUID REFERENCES known_plates(id) ON DELETE SET NULL,
  known_label TEXT,

  -- Kdy byla značka přečtená. NULL = čtení ještě neproběhlo.
  plate_read_at TIMESTAMPTZ,
  passed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cesta v úložišti, ne adresa. Kdyby se uložila celá URL, po změně
  -- domény projektu by snímky zmizely.
  CONSTRAINT vehicle_passages_image_is_path CHECK (
    image_path IS NULL OR image_path !~ '^[a-z]+://'
  ),
  -- Shoda se seznamem má smysl jen u přečtené značky.
  CONSTRAINT vehicle_passages_match_needs_plate CHECK (
    list_match IS NULL OR plate IS NOT NULL
  )
);

-- Jeden vjezd na detekci: opakované doručení téhož požadavku nesmí
-- založit druhý řádek.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_passages_detection
  ON vehicle_passages(detection_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_passages_site_time
  ON vehicle_passages(site_id, passed_at DESC);
-- Dotaz „kde všude se ta značka objevila“.
CREATE INDEX IF NOT EXISTS idx_vehicle_passages_plate
  ON vehicle_passages(plate_normalize(plate))
  WHERE plate IS NOT NULL;

COMMENT ON TABLE vehicle_passages IS
  'Průjezd vozidla bránou. plate IS NULL = značka nepřečtená nebo '
  'nečitelná. Vazba na zásah vede přes detection_id.';

-- ── updated_at a audit ───────────────────────────────────────────
-- known_plates je konfigurace (kdo smí do areálu), takže se auditují
-- stejně jako zóny a kamery. vehicle_passages jsou provozní data
-- a neauditují se, stejně jako detections.

DROP TRIGGER IF EXISTS known_plates_touch ON known_plates;
CREATE TRIGGER known_plates_touch
  BEFORE UPDATE ON known_plates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS known_plates_audit ON known_plates;
CREATE TRIGGER known_plates_audit
  AFTER INSERT OR UPDATE OR DELETE ON known_plates
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE known_plates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_passages  ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON known_plates TO authenticated;
GRANT ALL ON known_plates TO service_role;
GRANT SELECT ON vehicle_passages TO authenticated;
GRANT ALL ON vehicle_passages TO service_role;

-- known_plates: vidí, kdo vidí lokalitu; mění správce lokality.
--
-- Na rozdíl od constructiva-portal se zápis NEROZŠIŘUJE na každého,
-- kdo lokalitu vidí. Tam je seznam poznámka pro člověka; tady rozhoduje
-- o tom, jestli vzlétne dron — přidání značky na allow je vypnutí
-- ostrahy pro jedno auto a to nepatří klientovi.
DROP POLICY IF EXISTS "read_known_plates" ON known_plates;
CREATE POLICY "read_known_plates" ON known_plates
  FOR SELECT TO authenticated
  USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "write_known_plates" ON known_plates;
CREATE POLICY "write_known_plates" ON known_plates
  FOR ALL TO authenticated
  USING (site_is_manager(site_id))
  WITH CHECK (site_is_manager(site_id));

-- vehicle_passages: čte, kdo vidí lokalitu. Zapisuje výhradně ingest
-- pod service_role — žádná politika pro zápis neexistuje, takže ani
-- admin je z portálu nezaloží ani nesmaže. Je to důkaz, stejně jako
-- detekce.
DROP POLICY IF EXISTS "read_vehicle_passages" ON vehicle_passages;
CREATE POLICY "read_vehicle_passages" ON vehicle_passages
  FOR SELECT TO authenticated
  USING (site_is_visible(site_id));

-- ── Úložiště snímků ──────────────────────────────────────────────
-- Bucket je PRIVÁTNÍ, na rozdíl od log klientů: na snímku od brány
-- je cizí vozidlo, poznávací značka a kolikrát i řidič. Adresa se
-- podepisuje a podpis platí krátce.
--
-- Podmíněné existencí schématu `storage`: na produkci ho zakládá
-- Supabase, v lokální testovací databázi neexistuje.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE 'Schéma storage neexistuje (lokální databáze) — přeskakuji.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('vjezdy', 'vjezdy', FALSE, 4 * 1024 * 1024,
          ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  -- První složka v cestě je UUID lokality, takže se čtení dá omezit
  -- toutéž funkcí jako řádky: kdo lokalitu nevidí, nedostane ani
  -- podepsanou adresu.
  EXECUTE 'DROP POLICY IF EXISTS "vjezdy_read" ON storage.objects';
  EXECUTE $pol$
    CREATE POLICY "vjezdy_read" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'vjezdy'
        AND public.site_is_visible(((storage.foldername(name))[1])::uuid)
      )
  $pol$;

  -- Zápis nikomu z přihlášených: snímky nahrává ingest pod service_role.
  EXECUTE 'DROP POLICY IF EXISTS "vjezdy_write" ON storage.objects';

  RAISE NOTICE 'Bucket vjezdy je připravený.';
END $$;
