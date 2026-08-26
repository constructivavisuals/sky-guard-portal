-- ═══════════════════════════════════════════════════════════════════
-- Perimetrická ochrana dronem — datový model, RLS a audit.
--
-- Tok dat:
--   sites (lokalita s dockem) → zones (body perimetru) → cameras
--   cameras → detections (co kamera viděla)
--   detections → dispatches (výjezd poslaný do DJI FlightHub)
--   dispatches → flights (co dron skutečně odletěl) → media (foto/video v R2)
--
-- Konvence mazání: konfigurace se maže kaskádou, důkazy přežívají.
-- Tabulky s důkazy (detections, dispatches, flights, media) drží FK
-- s ON DELETE RESTRICT — kameru/lokalitu s historií nelze smazat,
-- místo toho se přepne status na 'decommissioned'. R2 objekty maže
-- aplikace, DB o nich drží jen klíč.
--
-- Idempotentní: bezpečné spustit víckrát (CREATE … IF NOT EXISTS,
-- DROP POLICY/TRIGGER IF EXISTS, enumy přes DO bloky).
-- ═══════════════════════════════════════════════════════════════════

-- ── PostGIS ──────────────────────────────────────────────────────
-- Supabase drží rozšíření v samostatném schématu `extensions`.
-- IF NOT EXISTS je no-op, pokud už postgis existuje jinde (třeba
-- v public) — proto se search_path níž rozšiřuje o obě varianty
-- a typy geography se v DDL píšou nekvalifikovaně (uloží se OID).

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

SET search_path = public, extensions;

-- ── Enums ────────────────────────────────────────────────────────

-- Role v portálu. Sky Guard je interní jednonájemní portál:
-- 'viewer' čte, 'operator' čte + kvituje provoz, 'admin' spravuje vše.
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE camera_status AS ENUM (
    'online', 'offline', 'maintenance', 'decommissioned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE detection_object_class AS ENUM ('person', 'vehicle', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Proč výjezd (ne)odletěl. suppressed_* jsou legitimní stavy, ne chyby:
-- 'suppressed_disarmed'  — mimo armed okno lokality,
-- 'suppressed_cooldown'  — v cooldown_seconds od předchozího výjezdu,
-- 'failed'               — FlightHub odmítl nebo neodpověděl.
DO $$ BEGIN
  CREATE TYPE dispatch_outcome AS ENUM (
    'sent', 'suppressed_disarmed', 'suppressed_cooldown', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flight_status AS ENUM (
    'pending', 'in_progress', 'completed', 'aborted', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE media_kind AS ENUM ('photo', 'video');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── profiles — identita a role ───────────────────────────────────
-- Vzor z constructiva-portal stojí na profiles(id, role); v tomhle
-- (novém, prázdném) projektu tabulka ještě neexistuje, takže ji
-- zakládá tahle migrace. Bez ní by se RLS neměla o co opřít.

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role user_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- ── sites — lokalita s dockem a dronem ───────────────────────────

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  -- Sériová čísla hardwaru na lokalitě (DJI Dock + dron v něm).
  dock_sn TEXT,
  drone_sn TEXT,
  -- Identifikátory z DJI FlightHub 2. Držíme je jako TEXT, ne UUID:
  -- jde o hodnoty z cizího API (env FH_PROJECT_UUID / FH_WORKFLOW_UUID)
  -- a nechceme, aby import spadl na validaci formátu.
  fh_project_uuid TEXT,
  fh_workflow_uuid TEXT,
  -- Perimetr lokality. WGS84; dotazy typu ST_Contains(geofence, point).
  geofence geography(Polygon, 4326),
  -- IANA zóna lokality. armed_from/armed_to/armed_days se vyhodnocují
  -- v ní, ne v UTC — jinak by se ostrý režim v létě posunul o hodinu
  -- (Europe/Prague je CET/CEST). Platnost hlídá trigger níž.
  timezone TEXT NOT NULL DEFAULT 'Europe/Prague',
  -- Okno, ve kterém se na detekci reaguje výjezdem. armed_from > armed_to
  -- znamená okno přes půlnoc (18:00 → 06:00), což je běžný případ.
  armed_from TIME NOT NULL DEFAULT '18:00',
  armed_to   TIME NOT NULL DEFAULT '06:00',
  -- ISO dny v týdnu (1 = pondělí … 7 = neděle).
  armed_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7],
  -- Minimální odstup mezi výjezdy; kratší detekce padnou do
  -- outcome 'suppressed_cooldown'.
  cooldown_seconds INTEGER NOT NULL DEFAULT 900 CHECK (cooldown_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sites_armed_days_valid
    CHECK (armed_days <@ ARRAY[1,2,3,4,5,6,7]
           AND COALESCE(array_length(armed_days, 1), 0) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_name ON sites(lower(name));
-- Partial unique: dock smí být přiřazen jen jedné lokalitě.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_dock_sn
  ON sites(dock_sn) WHERE dock_sn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sites_geofence ON sites USING GIST (geofence);

-- Neplatná zóna by shodila každé vyhodnocení ostrého režimu, tak ji
-- odchytneme už při zápisu. CHECK constraint to neumí — pg_timezone_names
-- ani AT TIME ZONE nejsou IMMUTABLE.
CREATE OR REPLACE FUNCTION sites_validate_timezone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Neznámá časová zóna: %', NEW.timezone;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sites_timezone_valid ON sites;
CREATE TRIGGER sites_timezone_valid
  BEFORE INSERT OR UPDATE OF timezone ON sites
  FOR EACH ROW EXECUTE FUNCTION sites_validate_timezone();

-- ── zones — hlídané body perimetru ───────────────────────────────

CREATE TABLE IF NOT EXISTS zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Bod, na který dron letí (waypoint). WGS84.
  location geography(Point, 4326),
  -- Výchozí stupeň zásahu 1–5 předaný do FlightHub jako level_sent.
  default_level SMALLINT NOT NULL DEFAULT 1
    CHECK (default_level BETWEEN 1 AND 5),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zones_site ON zones(site_id);
CREATE INDEX IF NOT EXISTS idx_zones_location ON zones USING GIST (location);
-- Název zóny unikátní v rámci lokality (ať UI nemá dvě "Brána sever").
CREATE UNIQUE INDEX IF NOT EXISTS idx_zones_site_name
  ON zones(site_id, lower(name));

-- ── cameras ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Zóna, kterou kamera hlídá. Kamera bez zóny je zatím nezapojená.
  -- Jediná vazba mezi zónou a kamerou — zóna sama na kameru neukazuje,
  -- pokrývající kamery se čtou přes cameras.zone_id.
  zone_id UUID REFERENCES zones(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  model TEXT,
  serial_number TEXT UNIQUE,
  -- Adresa v LAN lokality; INET validuje formát už na úrovni DB.
  lan_ip INET,
  -- Ohnisko objektivu v mm — spolu s mount_description slouží
  -- k přepočtu pixelové detekce na reálnou vzdálenost.
  focal_mm NUMERIC(6,2) CHECK (focal_mm IS NULL OR focal_mm > 0),
  mount_description TEXT,
  status camera_status NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cameras_site ON cameras(site_id);
CREATE INDEX IF NOT EXISTS idx_cameras_zone ON cameras(zone_id);
CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_site_name
  ON cameras(site_id, lower(name));

-- ── detections — co kamera viděla ────────────────────────────────

CREATE TABLE IF NOT EXISTS detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  -- Zóna může chybět (kamera bez přiřazení, detekce mimo perimetr).
  zone_id UUID REFERENCES zones(id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  object_class detection_object_class NOT NULL DEFAULT 'unknown',
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- Klíč snímku v R2, ne veřejná URL.
  -- Cesta snímku v úložišti, ne URL. Přejmenováno migrací
  -- 20260902180000 z snapshot_r2_key; tady je nová podoba proto, aby
  -- čerstvá databáze vznikla rovnou správně a znovuspuštění tohohle
  -- souboru neshodilo index na starém jméně.
  storage_path TEXT,
  -- Syrová odpověď detektoru (bounding boxy, model, verze).
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hlavní dotaz UI: "co viděla kamera X", nejnovější první.
CREATE INDEX IF NOT EXISTS idx_detections_camera_time
  ON detections(camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_zone_time
  ON detections(zone_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_class ON detections(object_class);

-- ── dispatches — pokus o výjezd do FlightHub ─────────────────────
-- Řádek vzniká i pro potlačené pokusy (outcome suppressed_*), aby
-- bylo dohledatelné, proč se neletělo.

CREATE TABLE IF NOT EXISTS dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
  -- NULL = ruční výjezd z portálu, ne reakce na detekci.
  triggered_by_detection UUID REFERENCES detections(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level_sent SMALLINT NOT NULL CHECK (level_sent BETWEEN 1 AND 5),
  -- UUID incidentu vrácené FlightHubem; u potlačených/chybných NULL.
  fh_incident_uuid TEXT,
  http_status INTEGER,
  -- Celá odpověď FlightHubu včetně chybového těla.
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome dispatch_outcome NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Odeslaný výjezd musí mít incident z FlightHubu, potlačený ho mít
  -- nesmí. 'failed' je bez omezení — selhat lze i po tom, co FlightHub
  -- incident založil (timeout při čtení odpovědi, odmítnutí dronem).
  CONSTRAINT dispatches_incident_matches_outcome CHECK (
    (outcome = 'sent' AND fh_incident_uuid IS NOT NULL)
    OR (outcome IN ('suppressed_disarmed', 'suppressed_cooldown')
        AND fh_incident_uuid IS NULL)
    OR outcome = 'failed'
  )
);

CREATE INDEX IF NOT EXISTS idx_dispatches_site_time
  ON dispatches(site_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatches_zone_time
  ON dispatches(zone_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatches_detection
  ON dispatches(triggered_by_detection);
CREATE INDEX IF NOT EXISTS idx_dispatches_outcome ON dispatches(outcome);
-- Partial unique: incident z FlightHubu je jedinečný, NULL jich smí
-- být kolik chce (potlačené a chybné pokusy).
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_fh_incident_uuid
  ON dispatches(fh_incident_uuid) WHERE fh_incident_uuid IS NOT NULL;

-- ── flights — co dron skutečně odletěl ───────────────────────────

CREATE TABLE IF NOT EXISTS flights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = let mimo portál (ruční mise, testovací vzlet z FlightHubu).
  dispatch_id UUID REFERENCES dispatches(id) ON DELETE SET NULL,
  fh_task_id TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  status flight_status NOT NULL DEFAULT 'pending',
  -- Telemetrie trasy z FlightHubu (pole bodů lat/lon/alt/ts).
  trajectory JSONB NOT NULL DEFAULT '{}'::jsonb,
  distance_m NUMERIC(10,2) CHECK (distance_m IS NULL OR distance_m >= 0),
  duration_s INTEGER CHECK (duration_s IS NULL OR duration_s >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT flights_time_order CHECK (
    ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at
  )
);

-- Sloupec fh_task_id zrušila migrace 20260826180000. CREATE TABLE IF
-- NOT EXISTS ho do existující tabulky nevrátí, ale samotný CREATE INDEX
-- by na jeho nepřítomnosti spadl — a tím by se celé znovuspuštění téhle
-- migrace zastavilo dřív, než dojde na definice funkcí. Idempotence
-- tady není kosmetika: na ní stojí to, že se soubor smí pustit znovu.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'flights'
       AND column_name = 'fh_task_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_flights_fh_task_id ON flights(fh_task_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_flights_dispatch ON flights(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_flights_status ON flights(status);
CREATE INDEX IF NOT EXISTS idx_flights_started ON flights(started_at DESC);

-- ── media — snímky a videa z letu ────────────────────────────────

CREATE TABLE IF NOT EXISTS media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id UUID NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  kind media_kind NOT NULL,
  -- Cesta v privátním bucketu, ne veřejná URL. Smazání řádku neuklidí
  -- úložiště — to je práce aplikace (retenční job).
  storage_path TEXT NOT NULL,
  captured_at TIMESTAMPTZ,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_flight ON media(flight_id);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
CREATE INDEX IF NOT EXISTS idx_media_captured ON media(captured_at DESC);
-- Jeden objekt v úložišti = jeden řádek (idempotentní import z FlightHubu).
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_storage_path ON media(storage_path);

-- ── updated_at auto-touch ────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'sites', 'zones', 'cameras', 'flights'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t
    );
  END LOOP;
END $$;

-- ── audit_log (append-only, vzor crm_audit_log / camera_audit_log) ─

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);

-- Append-only: UPDATE/DELETE blokuje trigger (platí i pro service role).
CREATE OR REPLACE FUNCTION audit_log_deny_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log je append-only — UPDATE/DELETE nejsou povoleny';
END; $$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();

-- ── Audit trigger na konfiguračních tabulkách ────────────────────
-- SECURITY DEFINER: zápis do logu projde i uživateli, který do
-- audit_log sám psát nesmí. detections/flights/media se neauditují —
-- vysokofrekvenční ingest by log zahltil a samy jsou už záznamem.

CREATE OR REPLACE FUNCTION audit_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row     JSONB;
  v_entity  UUID;
  v_meta    JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
    v_meta := jsonb_build_object('old', v_row);
  ELSIF TG_OP = 'UPDATE' THEN
    v_row := to_jsonb(NEW);
    -- Jen skutečně změněná pole — log zůstane čitelný.
    v_meta := jsonb_build_object(
      'changed', (
        SELECT COALESCE(jsonb_object_agg(key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb)
        FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
        JOIN jsonb_each(v_row) AS n(key, value) USING (key)
        WHERE o.value IS DISTINCT FROM n.value
          AND key <> 'updated_at'
      )
    );
    -- Bez reálné změny (jen touch updated_at) se nezapisuje nic.
    IF v_meta->'changed' = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  ELSE
    v_row := to_jsonb(NEW);
    v_meta := jsonb_build_object('new', v_row);
  END IF;

  v_entity := (v_row->>'id')::UUID;

  INSERT INTO audit_log (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), lower(TG_OP), TG_TABLE_NAME, v_entity, v_meta);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'sites', 'zones', 'cameras', 'dispatches'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t, t
    );
  END LOOP;
END $$;

-- ── Helper funkce pro RLS (vzor is_admin / camera_is_visible) ─────
-- Všechny SECURITY DEFINER: čtou profiles a konfigurační tabulky bez
-- RLS, takže se politiky nezacyklí (policy na cameras → lookup site
-- → policy na sites → …).

CREATE OR REPLACE FUNCTION current_role_of_user()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_role_of_user() = 'admin';
$$;

CREATE OR REPLACE FUNCTION is_operator()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_role_of_user() IN ('admin', 'operator');
$$;

-- Sky Guard je zatím jednonájemní: kdo má profil, vidí všechny lokality.
-- Parametr p_site_id je tu schválně — až přibude tabulka grantů
-- (přístup klienta jen na svou lokalitu), mění se jen tělo téhle
-- funkce, ne jednotlivé politiky.
--
-- Tělo je ZÁMĚRNĚ nejpřísnější možné: vidí jen admin. Rozšiřuje ho až
-- migrace 20260824180000 o granty. Kdyby tady zůstalo „vidí každý, kdo
-- má profil“, stačilo by tenhle soubor jednou pustit znovu — kvůli
-- opravě, kvůli `supabase db push` — a každý klient by tiše viděl
-- všechny lokality. Migrace se pouštějí ručně, takže tenhle omyl je na
-- dosah; při tomhle pořadí je nejhorší možný následek opačný, totiž že
-- klient dočasně nevidí nic.
CREATE OR REPLACE FUNCTION site_is_visible(p_site_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_site_id IS NOT NULL AND is_admin();
$$;

-- Právo měnit konfiguraci lokality.
CREATE OR REPLACE FUNCTION site_is_manager(p_site_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_site_id IS NOT NULL AND is_admin();
$$;

-- Průchody vazbami — čtou tabulky bez RLS, aby politiky na
-- detections/media nemusely dělat poddotaz do chráněných tabulek.
CREATE OR REPLACE FUNCTION camera_site_id(p_camera_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT site_id FROM cameras WHERE id = p_camera_id;
$$;

CREATE OR REPLACE FUNCTION flight_site_id(p_flight_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.site_id
  FROM flights f
  JOIN dispatches d ON d.id = f.dispatch_id
  WHERE f.id = p_flight_id;
$$;

-- Let bez dispatche (ruční mise mimo portál) nemá lokalitu → vidí ho
-- jen admin. Totéž platí pro jeho media.
CREATE OR REPLACE FUNCTION flight_is_visible(p_flight_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN flight_site_id(p_flight_id) IS NULL THEN is_admin()
    ELSE site_is_visible(flight_site_id(p_flight_id))
  END;
$$;

-- ── Ostrý režim lokality ─────────────────────────────────────────
-- Protějšek isSiteArmed() z src/types/database.ts — obě implementace
-- musí dávat stejnou odpověď, proto stejná pravidla:
--   armed_from = armed_to  → nikdy (prázdné okno, ne 24 h),
--   armed_from < armed_to  → denní okno v rámci jednoho dne,
--   armed_from > armed_to  → okno přes půlnoc; večerní část patří
--                            dnešku, ranní včerejšku (pátek 18:00–06:00
--                            zahrnuje i sobotní ráno).
-- Vše se počítá z p_at AT TIME ZONE s.timezone, tedy z nástěnných
-- hodin lokality včetně letního času.

CREATE OR REPLACE FUNCTION site_is_armed(
  p_site_id UUID,
  p_at TIMESTAMPTZ DEFAULT now()
)
-- Kontrola viditelnosti je tu ze stejného důvodu jako u
-- site_is_visible() výš: kdyby se tenhle soubor pustil znovu, nesmí
-- přepsat pozdější migraci 20260829180000 do volnější podoby. Bez ní
-- by se přes RPC dalo bez přihlášení zjistit, jestli je cizí areál
-- právě střežený.
--
-- NULL, ne FALSE: „nesmíš vědět“ není totéž co „není střeženo“.
-- Service role (ingest, cron) auth.uid() nemá a odpověď potřebuje bez
-- ohledu na granty — rozhoduje podle ní o zásahu, ne o zobrazení.
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN auth.uid() IS NOT NULL AND NOT site_is_visible(p_site_id) THEN NULL
    ELSE (
      SELECT CASE
        WHEN s.armed_from = s.armed_to THEN FALSE
        WHEN s.armed_from < s.armed_to THEN
          EXTRACT(ISODOW FROM l.local_ts)::INT = ANY (s.armed_days)
          AND l.local_ts::TIME >= s.armed_from
          AND l.local_ts::TIME <  s.armed_to
        WHEN l.local_ts::TIME >= s.armed_from THEN
          EXTRACT(ISODOW FROM l.local_ts)::INT = ANY (s.armed_days)
        WHEN l.local_ts::TIME <  s.armed_to THEN
          EXTRACT(ISODOW FROM l.local_ts - INTERVAL '1 day')::INT = ANY (s.armed_days)
        ELSE FALSE
      END
      FROM sites s
      CROSS JOIN LATERAL (SELECT p_at AT TIME ZONE s.timezone AS local_ts) l
      WHERE s.id = p_site_id
    )
  END;
$$;

-- ── RLS ──────────────────────────────────────────────────────────
-- Zápis přes portál je adminský; ingest (detekce, výjezdy, lety,
-- media) běží pod service role, která RLS obchází.

ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras     ENABLE ROW LEVEL SECURITY;
ALTER TABLE detections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE flights     ENABLE ROW LEVEL SECURITY;
ALTER TABLE media       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;

-- profiles: každý vidí sebe, admin vidí a spravuje všechny.
-- Vlastní řádek uživatel měnit nesmí (jinak by si přepsal roli).
DROP POLICY IF EXISTS "read_profiles" ON profiles;
CREATE POLICY "read_profiles" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR is_admin());

DROP POLICY IF EXISTS "write_profiles" ON profiles;
CREATE POLICY "write_profiles" ON profiles
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- sites
DROP POLICY IF EXISTS "read_sites" ON sites;
CREATE POLICY "read_sites" ON sites
  FOR SELECT TO authenticated USING (site_is_visible(id));

DROP POLICY IF EXISTS "write_sites" ON sites;
CREATE POLICY "write_sites" ON sites
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- zones
DROP POLICY IF EXISTS "read_zones" ON zones;
CREATE POLICY "read_zones" ON zones
  FOR SELECT TO authenticated USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "write_zones" ON zones;
CREATE POLICY "write_zones" ON zones
  FOR ALL TO authenticated
  USING (site_is_manager(site_id)) WITH CHECK (site_is_manager(site_id));

-- cameras
DROP POLICY IF EXISTS "read_cameras" ON cameras;
CREATE POLICY "read_cameras" ON cameras
  FOR SELECT TO authenticated USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "write_cameras" ON cameras;
CREATE POLICY "write_cameras" ON cameras
  FOR ALL TO authenticated
  USING (site_is_manager(site_id)) WITH CHECK (site_is_manager(site_id));

-- detections: portál je jen čte, zapisuje detektor pod service role.
DROP POLICY IF EXISTS "read_detections" ON detections;
CREATE POLICY "read_detections" ON detections
  FOR SELECT TO authenticated USING (site_is_visible(camera_site_id(camera_id)));

DROP POLICY IF EXISTS "write_detections" ON detections;
CREATE POLICY "write_detections" ON detections
  FOR ALL TO authenticated
  USING (site_is_manager(camera_site_id(camera_id)))
  WITH CHECK (site_is_manager(camera_site_id(camera_id)));

-- dispatches: čte kdo vidí lokalitu, zakládá server (service role).
-- Ruční výjezd z portálu smí spustit operátor i admin.
DROP POLICY IF EXISTS "read_dispatches" ON dispatches;
CREATE POLICY "read_dispatches" ON dispatches
  FOR SELECT TO authenticated USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "insert_dispatches" ON dispatches;
CREATE POLICY "insert_dispatches" ON dispatches
  FOR INSERT TO authenticated
  WITH CHECK (site_is_visible(site_id) AND is_operator());

DROP POLICY IF EXISTS "update_dispatches" ON dispatches;
CREATE POLICY "update_dispatches" ON dispatches
  FOR UPDATE TO authenticated
  USING (site_is_manager(site_id)) WITH CHECK (site_is_manager(site_id));

DROP POLICY IF EXISTS "delete_dispatches" ON dispatches;
CREATE POLICY "delete_dispatches" ON dispatches
  FOR DELETE TO authenticated USING (site_is_manager(site_id));

-- flights
DROP POLICY IF EXISTS "read_flights" ON flights;
CREATE POLICY "read_flights" ON flights
  FOR SELECT TO authenticated USING (flight_is_visible(id));

DROP POLICY IF EXISTS "write_flights" ON flights;
CREATE POLICY "write_flights" ON flights
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- media
DROP POLICY IF EXISTS "read_media" ON media;
CREATE POLICY "read_media" ON media
  FOR SELECT TO authenticated USING (flight_is_visible(flight_id));

DROP POLICY IF EXISTS "write_media" ON media;
CREATE POLICY "write_media" ON media
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- audit_log: čte jen admin, zápis jde přes SECURITY DEFINER trigger.
DROP POLICY IF EXISTS "read_audit_log" ON audit_log;
CREATE POLICY "read_audit_log" ON audit_log
  FOR SELECT TO authenticated USING (is_admin());
