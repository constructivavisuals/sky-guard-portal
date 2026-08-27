-- ═══════════════════════════════════════════════════════════════════
-- Servisní role pro relay.
--
-- Relay běží na cizím serveru, takže na něm leží přihlašovací údaje.
-- Kompromitace VPS nesmí znamenat přístup k celé databázi — proto
-- vlastní role s právy na jednotlivé SLOUPCE, ne service_role klíč.
--
-- Dvě role, ne jedna: příjem je připisovací, úklid maže. Kdyby to byla
-- jedna, proces přijímající soubory z FTP by uměl zároveň mazat video.
--
-- Časosběr tu roli nemá — snímky a rendery zůstávají v constructiva-
-- portal, kde na ně servisní role už existují.
--
-- ═══ cam_ingest a razítko last_seen_at ═════════════════════════════
-- V constructivě je cam_ingest čistě append-only. Tady dostane navíc
-- UPDATE na JEDINÝ sloupec: cameras.last_seen_at.
--
-- Je to vědomé rozšíření a platí se jím za to, že odpadá celý hlídač
-- výpadků (tabulka camera_health, dvě SECURITY DEFINER funkce, kontejner
-- a webhook). Sky Guard už umí varovat podle last_seen_at sám, takže
-- stačí, aby ho někdo plnil.
--
-- Grant je sloupcový a test práv ho hlídá jmenovitě — jinak se z toho
-- za rok stane role, která umí přepsat kameře sériové číslo.
--
-- Hesla se nastavují ručně, do gitu nepatří:
--   ALTER ROLE cam_ingest    PASSWORD 'vygenerované-heslo';
--   ALTER ROLE cam_retention PASSWORD 'vygenerované-heslo';
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── cam_ingest — příjem záznamů ──────────────────────────────────

DO $$ BEGIN
  CREATE ROLE cam_ingest NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER ROLE cam_ingest LOGIN;
ALTER ROLE cam_ingest CONNECTION LIMIT 5;
-- Dotazy jsou krátké; dlouho trvá ffmpeg a přenos, ne databáze.
ALTER ROLE cam_ingest SET statement_timeout = '30s';
ALTER ROLE cam_ingest SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO cam_ingest;

-- Dohledání kamery: jen to, čím se identifikuje. Žádné lan_ip,
-- credentials_secret_name ani zone_id.
GRANT SELECT (id, ftp_username, serial_number, ingest_mode) ON cameras TO cam_ingest;
-- Razítko, že se kamera ozvala. Jediný sloupec, který smí měnit.
GRANT UPDATE (last_seen_at) ON cameras TO cam_ingest;

-- Čte se výhradně kvůli idempotenci.
GRANT SELECT (id, sd_file_path) ON camera_recordings TO cam_ingest;
GRANT INSERT (
  camera_id, started_at, ended_at, event_type,
  sd_file_path, r2_key, size_bytes
) ON camera_recordings TO cam_ingest;

DROP POLICY IF EXISTS "ingest_read_cameras" ON cameras;
CREATE POLICY "ingest_read_cameras" ON cameras
  FOR SELECT TO cam_ingest
  -- Kamera bez identifikace se stejně nedohledá.
  USING (ftp_username IS NOT NULL OR serial_number IS NOT NULL);

DROP POLICY IF EXISTS "ingest_touch_cameras" ON cameras;
CREATE POLICY "ingest_touch_cameras" ON cameras
  FOR UPDATE TO cam_ingest
  USING (ingest_mode = 'ftp')
  WITH CHECK (ingest_mode = 'ftp');

DROP POLICY IF EXISTS "ingest_read_camera_recordings" ON camera_recordings;
CREATE POLICY "ingest_read_camera_recordings" ON camera_recordings
  FOR SELECT TO cam_ingest
  USING (sd_file_path IS NOT NULL);

DROP POLICY IF EXISTS "ingest_insert_camera_recordings" ON camera_recordings;
CREATE POLICY "ingest_insert_camera_recordings" ON camera_recordings
  FOR INSERT TO cam_ingest
  WITH CHECK (
    sd_file_path IS NOT NULL
    -- Zapsat se dá jen ke kameře, která na FTP opravdu posílá.
    AND camera_id IN (SELECT id FROM cameras WHERE ingest_mode = 'ftp')
  );

COMMENT ON ROLE cam_ingest IS
  'Příjem záznamů z FTP relaye. Zakládá řádky v camera_recordings '
  'a razítkuje cameras.last_seen_at — nic jiného měnit nesmí. Heslo '
  'mimo git.';

-- ── cam_retention — úklid videí z R2 ─────────────────────────────

DO $$ BEGIN
  CREATE ROLE cam_retention NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER ROLE cam_retention LOGIN;
ALTER ROLE cam_retention CONNECTION LIMIT 2;
ALTER ROLE cam_retention SET statement_timeout = '120s';
ALTER ROLE cam_retention SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO cam_retention;

GRANT SELECT (id, clip_retention_days) ON sites TO cam_retention;
GRANT SELECT (id, site_id) ON cameras TO cam_retention;
GRANT SELECT (id, camera_id, started_at, r2_key, size_bytes, video_expired_at)
  ON camera_recordings TO cam_retention;
-- Označit video za smazané. Řádek se NEMAŽE a r2_key se nepřepisuje —
-- na oboje role právo nemá.
GRANT UPDATE (video_expired_at) ON camera_recordings TO cam_retention;

DROP POLICY IF EXISTS "retention_read_sites" ON sites;
CREATE POLICY "retention_read_sites" ON sites
  FOR SELECT TO cam_retention USING (true);

DROP POLICY IF EXISTS "retention_read_cameras" ON cameras;
CREATE POLICY "retention_read_cameras" ON cameras
  FOR SELECT TO cam_retention USING (true);

DROP POLICY IF EXISTS "retention_read_camera_recordings" ON camera_recordings;
CREATE POLICY "retention_read_camera_recordings" ON camera_recordings
  FOR SELECT TO cam_retention USING (true);

DROP POLICY IF EXISTS "retention_expire_camera_recordings" ON camera_recordings;
CREATE POLICY "retention_expire_camera_recordings" ON camera_recordings
  FOR UPDATE TO cam_retention
  -- Směr: označit se dá jen dosud neoznačený záznam. Expiraci nejde
  -- odvolat a tvářit se, že video zase je.
  USING (video_expired_at IS NULL)
  WITH CHECK (video_expired_at IS NOT NULL);

COMMENT ON ROLE cam_retention IS
  'Úklid videí ze stavebních kamer. Označuje video_expired_at; řádek '
  'nemaže a r2_key nepřepíše. Heslo mimo git.';
