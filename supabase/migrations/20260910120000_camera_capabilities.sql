-- ═══════════════════════════════════════════════════════════════════
-- Co kamera umí detekovat.
--
-- Perimetrové kamery zvládnou osobu, kamera na vrátnici osobu, vozidlo
-- i značku. Portál to dosud nevěděl, takže od každé kamery čekal
-- všechno — a nepoznal rozdíl mezi „kamera hlásí vozidlo, protože tam
-- vozidlo je“ a „kamera hlásí vozidlo, přestože to neumí“.
--
-- ═══ Tři booleany, ne text[] ═══════════════════════════════════════
-- Dotazy na schopnost jsou vždycky na JEDNU schopnost („kdo čte
-- značky“), ne na množinu. Boolean se dá indexovat parciálním indexem,
-- má NOT NULL DEFAULT (žádné „nevíme“ v datech) a v TypeScriptu je
-- z něj pole typu boolean, ne string, který se dá napsat s překlepem.
-- Pole by dávalo smysl u schopností, které se často přidávají — tyhle
-- tři jsou dané tím, co portál umí zpracovat, a přibývat budou po
-- letech, ne po týdnech.
--
-- Výchozí hodnoty odpovídají většině: perimetr umí osobu a nic víc.
-- Kamera na bránu se zaškrtne ručně.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS detects_person  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS detects_vehicle BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reads_plate     BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN cameras.detects_person IS
  'Umí kamera hlásit osobu. Detekce třídy, kterou kamera neumí, se '
  'zapíše (důkaz se nezahazuje), ale označí se v raw jako neočekávaná.';

COMMENT ON COLUMN cameras.detects_vehicle IS
  'Umí kamera hlásit vozidlo. Vjezd je detekce vozidla, takže kamera '
  'na bráně to mít musí.';

COMMENT ON COLUMN cameras.reads_plate IS
  'Čte kamera značku sama. Ingest pak bere plate z těla požadavku '
  'a model se volá, jen když značka chybí nebo je pod prahem jistoty '
  '(PLATE_CONFIDENCE_MIN). U ostatních kamer se plate z těla ignoruje '
  '— jinak by šlo poslat vjezd s vymyšlenou značkou z libovolné '
  'kamery, kterou útočník ovládne.';

-- Čtení značky bez detekce vozidla je nesmysl: vjezd JE detekce
-- vozidla a taková kamera by si sama hlásila neočekávané události.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_plate_needs_vehicle;
ALTER TABLE cameras ADD CONSTRAINT cameras_plate_needs_vehicle CHECK (
  NOT reads_plate OR detects_vehicle
);

-- ── Odkud je značka ──────────────────────────────────────────────
--
-- Když značku hlásí kamera sama, je to jiný důkaz než čtení modelem:
-- u sporného vjezdu se musí dát poznat, kdo se spletl. Bez sloupce by
-- to šlo dohledat jedině v logu, a ten za týden není.

DO $$ BEGIN
  CREATE TYPE plate_source AS ENUM ('camera', 'model');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE vehicle_passages
  ADD COLUMN IF NOT EXISTS plate_source plate_source;

COMMENT ON COLUMN vehicle_passages.plate_source IS
  'Odkud je značka: camera = z těla požadavku od kamery s reads_plate, '
  'model = přečtená ze snímku. NULL u nepřečtených a u vjezdů z doby '
  'před migrací 20260910120000.';

-- Zdroj bez značky by tvrdil, že něco přečetl někdo, kdo nic nepřečetl.
ALTER TABLE vehicle_passages DROP CONSTRAINT IF EXISTS vehicle_passages_source_needs_plate;
ALTER TABLE vehicle_passages ADD CONSTRAINT vehicle_passages_source_needs_plate CHECK (
  plate_source IS NULL OR plate IS NOT NULL
);
