-- ═══════════════════════════════════════════════════════════════════
-- Kamera, která posílá přes FTP.
--
-- Dosud uměl portál jediný způsob příjmu: kamera podepíše požadavek
-- HMAC klíčem a pošle ho na /api/ingest. Stavební Dahua kamery to
-- neumí — nahrávají na FTP a o portálu nevědí. Přijímá je relay
-- (infra/cam-relay), který soubor remuxne, uloží do R2 a založí řádek.
--
-- ═══ Jedna tabulka, dva způsoby příjmu ═════════════════════════════
-- Kamera je fyzické zařízení a patří na jeden řádek. Dvě tabulky by
-- tentýž přístroj vedly dvakrát a každý dotaz „co má lokalita za
-- kamery“ by musel sjednocovat.
--
-- Rozdíl mezi nimi je ale bezpečnostní, ne kosmetický, a proto ho nese
-- výslovný sloupec `ingest_mode`, ne odvozenina z toho, který sloupec
-- je vyplněný:
--
--   http  kamera se podepisuje vlastním klíčem odvozeným z INGEST_SECRET
--         a sériového čísla. Ověřuje se každý požadavek.
--   ftp   kamera se neověřuje NIJAK. Chrání ji jen to, že na FTP
--         nikdo jiný nedosáhne — relay má port vázaný na localhost.
--
-- Kdo čte kód, musí ten rozdíl vidět na první pohled. Odvozovat ho ze
-- souběhu tří nullable sloupců je přesně ten druh chytrosti, po kterém
-- si za rok někdo splete, čemu se dá věřit.
--
-- ═══ sd_retention_days, ne retention_days ══════════════════════════
-- Constructiva má na kameře sloupec `retention_days` a její README před
-- ním varuje, protože se plete s retencí úložiště. Ve Sky Guardu už
-- `sites.retention_days` znamená „jak dlouho držíme soubory my“, takže
-- se sloupec rovnou zakládá pod jménem, které si to nemůže splést.
-- Není to přejmenování: `cameras.retention_days` tu nikdy nebyl.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

DO $$ BEGIN
  CREATE TYPE camera_ingest_mode AS ENUM ('http', 'ftp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS ingest_mode camera_ingest_mode NOT NULL DEFAULT 'http';

COMMENT ON COLUMN cameras.ingest_mode IS
  'Jak kamera doručuje data. http = podepsaný požadavek na /api/ingest '
  '(ověřuje se). ftp = nahrává na relay, který ji NEOVĚŘUJE — chrání ji '
  'jen nedostupnost FTP zvenčí.';

-- ── FTP a vzdálený přístup ───────────────────────────────────────

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS ftp_username TEXT,
  ADD COLUMN IF NOT EXISTS tailscale_host TEXT,
  ADD COLUMN IF NOT EXISTS rtsp_main_path TEXT,
  ADD COLUMN IF NOT EXISTS rtsp_sub_path TEXT,
  ADD COLUMN IF NOT EXISTS credentials_secret_name TEXT,
  ADD COLUMN IF NOT EXISTS sd_capacity_gb INTEGER,
  ADD COLUMN IF NOT EXISTS sd_retention_days INTEGER;

COMMENT ON COLUMN cameras.ftp_username IS
  'Účet, pod kterým kamera nahrává na relay. Databáze je zdroj pravdy '
  'pro mapování účtu na kameru, aby watcher neměl vlastní seznam. '
  'Heslo tu není — stejně jako u credentials_secret_name.';

COMMENT ON COLUMN cameras.tailscale_host IS
  'Jméno v tailnetu pro přístup ke kameře bez port-forwardu. Zatím '
  'nepoužité; živý obraz čeká na tunel do sítě se stavbou.';

COMMENT ON COLUMN cameras.sd_retention_days IS
  'Jak dlouho vydrží záznam na SD KARTĚ V KAMEŘE. Je to údaj o zařízení, '
  'ne naše rozhodnutí — to je sites.clip_retention_days.';

-- Partial unique: kamer bez FTP účtu může být libovolně mnoho.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_ftp_username
  ON cameras(ftp_username)
  WHERE ftp_username IS NOT NULL;

-- ── Pojistky ─────────────────────────────────────────────────────

-- Přihlašovací údaje ke kameře v databázi nejsou; držíme jen název
-- secretu. Tohle je pojistka proti typickému copy-paste omylu, převzatá
-- z constructiva-portal.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_secret_name_not_a_secret;
ALTER TABLE cameras ADD CONSTRAINT cameras_secret_name_not_a_secret CHECK (
  credentials_secret_name IS NULL
  OR (
    credentials_secret_name !~* '(password|heslo|passwd|:\s*\S+@)'
    AND length(credentials_secret_name) <= 200
  )
);

-- FTP kamera musí mít účet — bez něj ji watcher nedohledá a soubor
-- skončí ve failed.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_ftp_needs_username;
ALTER TABLE cameras ADD CONSTRAINT cameras_ftp_needs_username CHECK (
  ingest_mode <> 'ftp' OR ftp_username IS NOT NULL
);

-- FTP kamera nesmí mít ingest klíč. Otisk by tvrdil, že se požadavky
-- ověřují, a ony se neověřují — a při rotaci tajemství by se marně
-- hledalo, proč kamera „nehlásí“, když ji nikdo nevolá.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_ftp_has_no_key;
ALTER TABLE cameras ADD CONSTRAINT cameras_ftp_has_no_key CHECK (
  ingest_mode <> 'ftp' OR ingest_secret_hash IS NULL
);

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_sd_capacity_positive;
ALTER TABLE cameras ADD CONSTRAINT cameras_sd_capacity_positive CHECK (
  sd_capacity_gb IS NULL OR sd_capacity_gb > 0
);

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_sd_retention_positive;
ALTER TABLE cameras ADD CONSTRAINT cameras_sd_retention_positive CHECK (
  sd_retention_days IS NULL OR sd_retention_days > 0
);

-- Dohledání kamery watcherem: nejdřív sériové číslo, pak FTP účet.
-- Sériové číslo už unique je (základní migrace).
CREATE INDEX IF NOT EXISTS idx_cameras_ingest_mode ON cameras(ingest_mode);
