-- ═══════════════════════════════════════════════════════════════════
-- Záznamy ze stavebních kamer.
--
-- Kamera nahrává na FTP relay, ten soubor remuxne do MP4, uloží do R2
-- a založí tady řádek. Snímky pro časosběr sem NEPATŘÍ — ty zůstávají
-- v constructiva-portal, protože časosběr je marketingová funkce, ne
-- ostraha. Relay má proto dva cíle a rozděluje je podle přípony.
--
-- ═══ Řádek přežije video ═══════════════════════════════════════════
-- Po uplynutí lhůty (sites.clip_retention_days) se maže objekt v R2,
-- ale řádek zůstává a vyplní se video_expired_at. V portálu je pak
-- pořád vidět, že se v ten čas něco dělo — jen to nejde přehrát.
-- r2_key zůstává jako stopa, kde objekt byl, takže sám o sobě není
-- podmínkou přehratelnosti; tou je prázdné video_expired_at.
--
-- ═══ Idempotence stojí JEN na sd_file_path ═════════════════════════
-- Constructiva má vedle toho ještě unique (camera_id, started_at)
-- z doby před FTP příjmem a její README ho popisuje jako past: dvojice
-- main + sub stream téže kamery má stejný čas začátku, projde přes
-- sd_file_path a narazí na ten druhý index — watcher to pak bere jako
-- „nahrávku už máme“ a druhý stream zahodí.
--
-- Tady ten index ZÁMĚRNĚ NENÍ. Nová tabulka nemusí dědit past jen
-- proto, že ji má předloha.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS camera_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,

  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  -- Typ události z názvu souboru: motion, regular, alarm, intelligent.
  -- Ne enum — kamera může poslat příznak, který zatím neznáme, a nová
  -- hodnota nemá být důvod k migraci typu.
  event_type TEXT,

  -- Cesta v FTP inboxu relaye. Zároveň klíč idempotence příjmu.
  sd_file_path TEXT,
  -- Klíč remuxnutého MP4 v R2, ne veřejná adresa.
  r2_key TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),

  -- Kdy se video smazalo z R2 po uplynutí lhůty. NULL = video je tam.
  video_expired_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT camera_recordings_time_order CHECK (
    ended_at IS NULL OR ended_at >= started_at
  )
);

-- Idempotence příjmu. Partial: záznamů bez cesty (ruční import) může
-- být víc.
CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_recordings_sd_file_path
  ON camera_recordings(sd_file_path)
  WHERE sd_file_path IS NOT NULL;

-- Hlavní dotaz UI: „co má kamera X v okně od–do“, nejnovější první.
CREATE INDEX IF NOT EXISTS idx_camera_recordings_camera_time
  ON camera_recordings(camera_id, started_at DESC);

-- Retenční job hledá, co je za lhůtou a ještě má video.
CREATE INDEX IF NOT EXISTS idx_camera_recordings_to_expire
  ON camera_recordings(started_at)
  WHERE video_expired_at IS NULL;

COMMENT ON TABLE camera_recordings IS
  'Záznamy ze stavebních kamer přijaté přes FTP relay. Řádek přežije '
  'video: po lhůtě se maže objekt v R2 a vyplní video_expired_at.';

COMMENT ON COLUMN camera_recordings.r2_key IS
  'Klíč v R2, ne adresa. Zůstává i po smazání objektu jako stopa, kde '
  'byl — přehratelnost se pozná podle video_expired_at.';

-- ── RLS ──────────────────────────────────────────────────────────
--
-- Čte, kdo vidí lokalitu kamery. camera_site_id() je SECURITY DEFINER
-- ze základní migrace, takže se politika nezacyklí přes cameras.
--
-- Zápis nikomu z přihlášených: záznamy zakládá výhradně relay pod
-- servisní rolí (migrace 20260915180000). Je to důkazní tabulka, ne
-- něco, do čeho by měl kdokoli z portálu psát.

ALTER TABLE camera_recordings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_camera_recordings" ON camera_recordings;
CREATE POLICY "read_camera_recordings" ON camera_recordings
  FOR SELECT TO authenticated
  USING (site_is_visible(camera_site_id(camera_id)));

GRANT SELECT ON camera_recordings TO authenticated;
GRANT ALL ON camera_recordings TO service_role;
