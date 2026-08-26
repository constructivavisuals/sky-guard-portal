-- ═══════════════════════════════════════════════════════════════════
-- Retence souborů v úložišti.
--
-- Komentář u media.storage_path od začátku říká „smazání řádku
-- neuklidí úložiště — to je práce aplikace (retenční job)“. Ten job
-- neexistoval, takže videa z dronu v bucketu `lety` rostla donekonečna;
-- jeden let jsou desítky megabajtů a hlídka létá každou hodinu.
--
-- Doba se nastavuje po lokalitách: areál s ostrahou na zakázku může
-- mít smluvně jinou lhůtu než vlastní. Devadesát dní je výchozí jako
-- rozumný kompromis mezi „ještě to někdo bude řešit“ a cenou úložiště.
--
-- MAŽOU SE JEN SOUBORY, řádky zůstávají. Detekce, vjezd i let jsou
-- důkazy a mizet nesmí; po lhůtě jen přestanou nést obrázek.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 90;

-- Nula ani záporná lhůta nedává smysl a strop je tu proti překlepu:
-- 9000 místo 90 by znamenalo „nikdy“, ale vypadalo by jako číslo.
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_retention_days_check;
ALTER TABLE sites ADD CONSTRAINT sites_retention_days_check
  CHECK (retention_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN sites.retention_days IS
  'Po kolika dnech se z úložiště mažou snímky a záznamy z letů. '
  'Řádky zůstávají — mizí jen soubory, na které odkazují.';
