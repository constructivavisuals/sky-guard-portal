-- ═══════════════════════════════════════════════════════════════════
-- Co lokalita má: dron, kamery, nebo obojí.
--
-- Portál dosud předpokládal, že každá lokalita je areál s dronem.
-- Stavba s kamerami a bez dronu ale nemá zásahy, lety, hlídky ani dok —
-- a klientovi, který má obojí, nemá smysl ukazovat na stavbě polovinu
-- menu, která pro ni nedává smysl.
--
-- ═══ Proč sloupce a ne odvozenina z dock_sn ════════════════════════
-- Nabízelo by se odvodit „má dron“ z toho, že lokalita má sériové číslo
-- doku. Jenže dok se doplňuje až při montáži: lokalita, která na dron
-- teprve čeká, by se tvářila jako stavba a zmizely by z ní stránky,
-- které se právě chystají. Schopnost je rozhodnutí, ne vedlejší efekt
-- vyplněného pole.
--
-- ═══ Dvě lhůty na jedné tabulce ════════════════════════════════════
-- sites.retention_days (90 dní) je lhůta pro Supabase Storage — snímky
-- detekcí, vjezdů a média letů. clip_retention_days (14 dní) je lhůta
-- pro video ze stavebních kamer v R2. Jsou to jiná data, jiné úložiště
-- i jiný řád velikosti, proto dva sloupce. Splynout nesmí.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS has_drone   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS has_cameras BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sites.has_drone IS
  'Má lokalita dron? Řídí, jestli se v menu ukazují Zásahy, Lety, Hlídky '
  'a stav doku. Výchozí TRUE, protože všechny stávající lokality jsou '
  'areály s dronem.';

COMMENT ON COLUMN sites.has_cameras IS
  'Má lokalita stavební kamery? Řídí Detekce a Bránu. U areálu s dronem '
  'může být obojí zároveň.';

-- Lokalita bez dronu i bez kamer nemá co ukazovat — v menu by zbyl
-- přehled a nastavení. Je to překlep, ne stav.
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_has_something;
ALTER TABLE sites ADD CONSTRAINT sites_has_something CHECK (
  has_drone OR has_cameras
);

-- ── Lhůty a prahy pro kamerový modul ─────────────────────────────

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS clip_retention_days INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS offline_threshold_minutes INTEGER NOT NULL DEFAULT 120;

COMMENT ON COLUMN sites.clip_retention_days IS
  'Jak dlouho držíme video ze stavebních kamer v R2. NENÍ to totéž co '
  'retention_days (90 dní, Supabase Storage) ani co cameras.'
  'sd_retention_days (kapacita SD karty v kameře).';

COMMENT ON COLUMN sites.offline_threshold_minutes IS
  'Jak dlouho kamera nemusí nic poslat, než ji bereme za nehlásící. '
  'Na lokalitu, protože stavba s kontinuálním záznamem má jiné '
  'očekávání než areál s pár detekcemi za noc.';

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_clip_retention_sane;
ALTER TABLE sites ADD CONSTRAINT sites_clip_retention_sane CHECK (
  clip_retention_days BETWEEN 1 AND 3650
);

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_offline_threshold_sane;
ALTER TABLE sites ADD CONSTRAINT sites_offline_threshold_sane CHECK (
  offline_threshold_minutes BETWEEN 5 AND 10080
);
