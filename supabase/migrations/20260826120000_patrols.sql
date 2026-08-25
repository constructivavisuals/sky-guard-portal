-- ═══════════════════════════════════════════════════════════════════
-- Pravidelné hlídky.
--
-- Hlídka je předpis: na které lokalitě, po jaké trase, v jakém okně
-- a jak často. Cron z něj počítá konkrétní lety a zakládá je ve
-- FlightHubu.
--
-- Lety dostávají kind, aby šlo odlišit hlídku od zásahu — dosud byl
-- každý let reakcí na detekci.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── patrols ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patrols (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Trasa ve FlightHubu. Držíme jako TEXT, ne UUID — je to hodnota
  -- z cizího API a nechceme, aby import spadl na validaci formátu.
  wayline_uuid TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Okno, ve kterém hlídky létají. window_from > window_to znamená
  -- okno přes půlnoc, stejně jako u armed_from/armed_to na lokalitě.
  window_from TIME NOT NULL DEFAULT '08:00',
  window_to   TIME NOT NULL DEFAULT '18:00',
  -- ISO dny (1 = pondělí … 7 = neděle).
  days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7],
  -- Odstup mezi starty v rámci okna.
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patrols_days_valid
    CHECK (days <@ ARRAY[1,2,3,4,5,6,7] AND COALESCE(array_length(days, 1), 0) > 0),
  -- Nula by znamenala nekonečně letů, víc než den zase žádný.
  CONSTRAINT patrols_interval_valid
    CHECK (interval_minutes BETWEEN 1 AND 1440),
  -- Shodný začátek i konec by dal okno, které nikdy neplatí.
  CONSTRAINT patrols_window_valid CHECK (window_from <> window_to)
);

CREATE INDEX IF NOT EXISTS idx_patrols_site ON patrols(site_id);
-- Cron se ptá jen na zapnuté.
CREATE INDEX IF NOT EXISTS idx_patrols_enabled ON patrols(enabled) WHERE enabled;
CREATE UNIQUE INDEX IF NOT EXISTS idx_patrols_site_name
  ON patrols(site_id, lower(name));

-- ── flights: hlídka vs. zásah ────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE flight_kind AS ENUM ('patrol', 'dispatch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Stávající lety vznikly z detekcí, takže DEFAULT je doplní správně.
ALTER TABLE flights
  ADD COLUMN IF NOT EXISTS kind flight_kind NOT NULL DEFAULT 'dispatch';

ALTER TABLE flights
  ADD COLUMN IF NOT EXISTS fh_task_uuid TEXT;

ALTER TABLE flights
  ADD COLUMN IF NOT EXISTS patrol_id UUID;

-- Hlídku s odlétanými lety nelze smazat; vypíná se přes enabled,
-- stejně jako se kamera vyřazuje stavem místo mazání.
ALTER TABLE flights DROP CONSTRAINT IF EXISTS flights_patrol_id_fkey;
ALTER TABLE flights ADD CONSTRAINT flights_patrol_id_fkey
  FOREIGN KEY (patrol_id) REFERENCES patrols(id) ON DELETE RESTRICT;

ALTER TABLE flights DROP CONSTRAINT IF EXISTS flights_patrol_requires_patrol_id;
ALTER TABLE flights ADD CONSTRAINT flights_patrol_requires_patrol_id CHECK (
  kind <> 'patrol' OR patrol_id IS NOT NULL
);

-- Úloha z FlightHubu je jedinečná. Partial: NULL jich smí být kolik
-- chce (lety, které se nepodařilo založit).
CREATE UNIQUE INDEX IF NOT EXISTS idx_flights_fh_task_uuid
  ON flights(fh_task_uuid) WHERE fh_task_uuid IS NOT NULL;

-- Klíčová pojistka proti dvojímu naplánování: cron běží po pěti
-- minutách a dívá se deset dopředu, takže se okna překrývají. Kdyby
-- dva běhy dosáhly na tentýž slot naráz, druhý zápis spadne tady
-- místo aby vznikl druhý let.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flights_patrol_slot
  ON flights(patrol_id, started_at)
  WHERE patrol_id IS NOT NULL AND started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flights_kind ON flights(kind);

-- ── Automatika a audit ───────────────────────────────────────────

DROP TRIGGER IF EXISTS patrols_touch ON patrols;
CREATE TRIGGER patrols_touch BEFORE UPDATE ON patrols
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS patrols_audit ON patrols;
CREATE TRIGGER patrols_audit AFTER INSERT OR UPDATE OR DELETE ON patrols
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE patrols ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_patrols" ON patrols;
CREATE POLICY "read_patrols" ON patrols
  FOR SELECT TO authenticated
  USING (site_is_visible(site_id));

DROP POLICY IF EXISTS "write_patrols" ON patrols;
CREATE POLICY "write_patrols" ON patrols
  FOR ALL TO authenticated
  USING (site_is_manager(site_id))
  WITH CHECK (site_is_manager(site_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON patrols TO authenticated;
GRANT ALL ON patrols TO service_role;
