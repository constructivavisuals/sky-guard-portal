-- ═══════════════════════════════════════════════════════════════════
-- Práva na pomocné funkce a zúžení site_is_armed().
--
-- Postgres dává EXECUTE na novou funkci automaticky roli PUBLIC, tedy
-- i roli anon. Anon klíč je přitom veřejný z principu — je v bundlu
-- pro prohlížeč. Do teď proto stačilo poslat
--   POST /rest/v1/rpc/site_is_armed
-- s UUID lokality a bez jakéhokoli přihlášení se dalo zjistit, jestli
-- je areál právě střežený. Přesně ten údaj, kvůli kterému se tam někdo
-- vloupe.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Rozvrh střežení bez kontroly viditelnosti ────────────────────
-- Vnitřní funkce. Volá ji jen site_is_armed(), a protože ta je
-- SECURITY DEFINER, běží jako vlastník a právo na tuhle má implicitně.
-- Nikdo zvenčí ji zavolat nesmí — obešel by tím kontrolu níž.

CREATE OR REPLACE FUNCTION site_armed_schedule(
  p_site_id UUID,
  p_at TIMESTAMPTZ
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
  WHERE s.id = p_site_id;
$$;

-- ── Veřejná funkce s kontrolou viditelnosti ──────────────────────

CREATE OR REPLACE FUNCTION site_is_armed(
  p_site_id UUID,
  p_at TIMESTAMPTZ DEFAULT now()
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    -- Přihlášený se smí ptát jen na lokalitu, na kterou vidí. NULL, ne
    -- FALSE: „nesmíš vědět“ není totéž co „není střeženo“.
    --
    -- Service role (ingest, cron) auth.uid() nemá a odpověď potřebuje
    -- bez ohledu na granty — rozhoduje podle ní o zásahu, ne o tom, co
    -- komu ukázat. Role anon se sem nedostane, protože jí EXECUTE níž
    -- odebíráme.
    WHEN auth.uid() IS NOT NULL AND NOT site_is_visible(p_site_id) THEN NULL
    ELSE site_armed_schedule(p_site_id, p_at)
  END;
$$;

-- ── Práva ────────────────────────────────────────────────────────
--
-- POZOR: authenticated musí mít EXECUTE na všechno, co se objevuje
-- v RLS politikách — výraz politiky se vyhodnocuje právy dotazující se
-- role, takže bez EXECUTE nespadne jen ta funkce, ale celý dotaz.
-- Když se sem přidá další pomocná funkce, patří i do tohohle seznamu.

DO $$
DECLARE
  fn TEXT;
  verejne TEXT[] := ARRAY[
    'current_role_of_user()',
    'is_admin()',
    'is_operator()',
    'site_is_visible(uuid)',
    'site_is_manager(uuid)',
    'camera_site_id(uuid)',
    'flight_site_id(uuid)',
    'flight_is_visible(uuid)',
    -- Jedna funkce, ne dvě: druhý parametr má DEFAULT, takže volání
    -- s jedním argumentem míří na tentýž záznam v pg_proc.
    'site_is_armed(uuid, timestamptz)'
  ];
BEGIN
  FOREACH fn IN ARRAY verejne LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- Vnitřní rozvrh a triggerové funkce nesmí volat nikdo. Triggery se
-- spouštějí bez kontroly EXECUTE, takže jim odebrání práv nevadí.
DO $$
DECLARE
  fn TEXT;
  vnitrni TEXT[] := ARRAY[
    'site_armed_schedule(uuid, timestamptz)',
    'audit_row()',
    'audit_log_deny_mutation()',
    'touch_updated_at()',
    'sites_validate_timezone()'
  ];
BEGIN
  FOREACH fn IN ARRAY vnitrni LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
  END LOOP;
END $$;

-- Aby na to nedoplatila příští migrace: nové funkce v public už
-- nebudou pro PUBLIC spustitelné automaticky. Následek opomenutí je
-- pak hlasitá chyba práv, ne tiché vystavení.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
