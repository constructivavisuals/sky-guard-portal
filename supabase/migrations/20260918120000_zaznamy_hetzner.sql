-- ═══════════════════════════════════════════════════════════════════
-- Video ze stavebních kamer jde do Hetzner Object Storage.
--
-- ═══ Revize rozhodnutí z 20260915180000 ════════════════════════════
-- Ta migrace zakládala bucket `zaznamy` v Supabase Storage a druhé
-- úložiště výslovně odmítala: „Jedno úložiště, jedna autorizace.“
-- Argument stál na tom, že video se čtrnáctidenní lhůtou druhý
-- systém nezaplatí.
--
-- Ten odhad byl řádově vedle. Devět kamer nahrává NEPŘETRŽITĚ, ne
-- jen při pohybu: zhruba 300 GB denně, tedy přes 2 TB na týden, který
-- klient chce mít zpětně. To na Supabase Storage stojí násobky toho,
-- co 3 TB u Hetzneru (~26 $ měsíčně), a relay stojí v témže
-- datacentru ve Falkensteinu, takže nahrávání je zdarma.
--
-- Původní úvaha tedy nebyla chybná, jen počítala s jiným objemem.
-- Co z ní platí dál: druhé úložiště opravdu PŘINESLO druhou
-- autorizační cestu, a tu bylo nutné postavit — viz níž.
--
-- ═══ Co se NESTĚHUJE ═══════════════════════════════════════════════
-- Snímky detekcí, vjezdů a média z letů zůstávají v Supabase Storage.
-- Jsou malé, autorizace nad nimi stojí na politikách nad
-- storage.objects a ta funguje. Stěhuje se jen to, co je drahé.
--
-- ═══ Čím se nahradila RLS ══════════════════════════════════════════
-- Hetzner žádnou RLS nezná: S3 klíč platí na celý bucket. Čtení proto
-- neprochází úložištěm, ale portálem (/api/media): prefix v cestě určí
-- tabulku, existence řádku se ověří POD RLS klientem přihlášeného
-- uživatele, a teprve pak se podepíše adresa. Kdo na lokalitu nevidí,
-- dostane 404 i na cestu, kterou uhodl.
--
-- Bucket `zaznamy` ani jeho politika se NERUŠÍ: záznamy nahrané před
-- přechodem v něm leží dál a musí zůstat přehratelné. Který záznam
-- kam patří, říká camera_recordings.storage_backend.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Kde záznam leží ──────────────────────────────────────────────
--
-- Přidává se s DEFAULT 'supabase', aby STÁVAJÍCÍ řádky dostaly
-- správnou hodnotu — leží v Supabase a tam taky zůstanou. Teprve pak
-- se default překlopí na 'hetzner' pro nové. Opačné pořadí by označilo
-- historii za hetznerskou a portál by pak podepisoval adresy do
-- bucketu, kde ty soubory nejsou.

ALTER TABLE camera_recordings
  ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'supabase';

ALTER TABLE camera_recordings ALTER COLUMN storage_backend SET DEFAULT 'hetzner';

ALTER TABLE camera_recordings DROP CONSTRAINT IF EXISTS camera_recordings_backend_known;
ALTER TABLE camera_recordings ADD CONSTRAINT camera_recordings_backend_known CHECK (
  storage_backend IN ('supabase', 'hetzner')
);

COMMENT ON COLUMN camera_recordings.storage_backend IS
  'Kde soubor fyzicky leží. `hetzner` u nových, `supabase` u nahraných '
  'před přechodem. Bez toho by se nedalo poznat, čím adresu podepsat '
  'a odkud soubor po lhůtě smazat.';

-- ── Strop na objem ───────────────────────────────────────────────
--
-- Hetzner tvrdý limit nenabízí: bucket roste dál a přiteče faktura.
-- Při 300 GB denně vyjede zaseknutá retence přes rozpočet za pár dní,
-- takže si strop hlídáme sami — po vyčerpání portál přestane přijímat
-- záznamy (507) a hlásí to varováním.
--
-- 500 GB DEKADICKÝCH, ne GiB: Hetzner účtuje v TB po deseti mocninách
-- a strop, který se s fakturou nedá porovnat, je k ničemu.
-- Musí sedět s DEFAULT_RECORDING_QUOTA_BYTES v lib/recordings/storage.ts.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS recording_quota_bytes BIGINT NOT NULL
    DEFAULT 500000000000;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_recording_quota_sane;
ALTER TABLE sites ADD CONSTRAINT sites_recording_quota_sane CHECK (
  recording_quota_bytes > 0
);

COMMENT ON COLUMN sites.recording_quota_bytes IS
  'Strop na objem videa ze stavebních kamer v Hetzneru, v bajtech '
  '(dekadických). Po vyčerpání portál přestane přijímat záznamy. '
  'Hetzner tvrdý limit nenabízí, hlídá se to tady.';

-- Opravená poznámka: R2 se nikdy nepoužilo, video je v Hetzneru.
COMMENT ON COLUMN sites.clip_retention_days IS
  'Jak dlouho držíme video ze stavebních kamer v Hetzner Object '
  'Storage. NENÍ to totéž co retention_days (90 dní, Supabase Storage) '
  'ani co cameras.sd_retention_days (kapacita SD karty v kameře).';

-- ── Kolik lokalita zabírá ────────────────────────────────────────
--
-- Sčítá se z size_bytes, ne výpisem bucketu: výpis 2 TB objektů je
-- pomalý, platí se za něj a portál to potřebuje při KAŽDÉM ohlášení
-- záznamu. Zdrojem pravdy je velikost, kterou portál po nahrání
-- ZMĚŘIL v úložišti (viz /api/ingest/recording/confirm), ne tvrzení
-- relaye — takže je to součet měřených hodnot, ne odhad.
--
-- ═══ ZÁMĚRNĚ BEZ security definer ══════════════════════════════════
-- Stejně jako camera_recording_day_counts: funkce běží právy volajícího,
-- takže se uplatní RLS nad camera_recordings. Kdo na lokalitu nevidí,
-- dostane nulu — ne cizí čísla. Service role (portál) vidí vše.
--
-- Počítá se jen to, co v úložišti DOOPRAVDY leží: nepotvrzené nahrávání
-- ještě žádné místo nezabírá a po lhůtě smazané video už ne.

CREATE OR REPLACE FUNCTION site_recording_bytes(p_site_id UUID)
RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(r.size_bytes), 0)::BIGINT
  FROM camera_recordings r
  JOIN cameras c ON c.id = r.camera_id
  WHERE c.site_id = p_site_id
    AND r.uploaded_at IS NOT NULL
    AND r.video_expired_at IS NULL;
$$;

COMMENT ON FUNCTION site_recording_bytes(UUID) IS
  'Kolik bajtů videa lokalita drží v úložišti. Bez SECURITY DEFINER — '
  'RLS volajícího platí, takže na cizí lokalitu vrátí nulu.';

REVOKE ALL ON FUNCTION site_recording_bytes(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION site_recording_bytes(UUID) TO authenticated, service_role;

-- Součet i retenční výběr jdou přes „co ještě má video“. Bez indexu by
-- se při každém ohlášení četly všechny záznamy lokality — při 13 tisících
-- řádcích denně je to za týden stotisícový sken na každý přijatý soubor.
CREATE INDEX IF NOT EXISTS idx_camera_recordings_live
  ON camera_recordings(camera_id)
  WHERE uploaded_at IS NOT NULL AND video_expired_at IS NULL;

-- ── Varování o stropu ────────────────────────────────────────────
--
-- Vyčerpaný strop ZASTAVÍ příjem záznamů, takže se to člověk musí
-- dozvědět dřív, než si všimne, že v portálu chybí video. Zapnuté
-- ve výchozím stavu, jako ostatní provozní varování.

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS on_storage_quota BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN notification_prefs.on_storage_quota IS
  'Objem videa ze stavebních kamer u stropu lokality nebo přes něj. '
  'Po vyčerpání se záznamy nepřijímají — je to provozní stav, ne '
  'závada.';
