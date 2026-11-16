-- ═══════════════════════════════════════════════════════════════════
-- Rychlé RLS: viditelnost se počítá jednou na dotaz, ne na každý řádek.
--
-- ═══ Co bylo špatně ════════════════════════════════════════════════
-- Čtecí politiky velkých tabulek volaly funkci pro KAŽDÝ řádek:
--
--   detections         site_is_visible(site_id)
--   camera_recordings  site_is_visible(camera_site_id(camera_id))
--
-- Funkce jsou SECURITY DEFINER, takže je Postgres nemůže rozbalit do
-- dotazu, a uvnitř každého volání běží další poddotazy (profil kvůli
-- is_admin(), grant v site_grants, u klipů ještě kamera). Pro
-- desítky tisíc klipů jedné lokality to dělá desítky tisíc volání.
--
-- Naměřeno lokálně (PostgreSQL 17, 58 tisíc klipů a 120 tisíc detekcí
-- na lokalitu), na Supabase je CPU pomalejší a čísla horší:
--
--   počet klipů lokality (Přehled)          1 800 ms
--   posledních 50 klipů (Záznamy, osa)      1 700 ms
--   počet detekcí lokality (Detekce)        3 300 ms
--
-- Na telefonu z toho byl Přehled, který se načítal přes pět vteřin.
--
-- ═══ Co je teď ═════════════════════════════════════════════════════
-- visible_site_ids() vrátí lokality, které přihlášený vidí — jednou
-- na dotaz, jako nekorelovaný poddotaz (hashed SubPlan). Řádek se pak
-- jen porovná se seznamem o pár položkách.
--
-- ═══ Pravidlo se NEMĚNÍ ═════════════════════════════════════════════
-- visible_site_ids() je definovaná přes site_is_visible(), tedy přes
-- tutéž funkci, kterou politiky volaly dosud. Jen se volá na lokality
-- (jednotky řádků), ne na detekce (statisíce). Kdo co vidí, rozhoduje
-- pořád jediné místo. Shodu hlídá supabase/tests/rls_rychlost.sql:
-- pro admina, klienta s grantem i klienta bez grantu porovná, co vidí
-- teď, s tím, co by pustila původní podmínka.
--
-- Zapisovací politiky zůstávají, jak jsou: tabulky, kterých se týkají,
-- jsou malé, a zápis řeší jeden řádek.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── Pomocné funkce ─────────────────────────────────────────────────

-- ROWS: plánovač u funkcí vracejících množinu čeká 1000 řádků. Lokalit
-- jsou jednotky a kamer desítky; skutečný odhad mu pomůže zvolit
-- hashovaný poddotaz místo spojení.
CREATE OR REPLACE FUNCTION visible_site_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public ROWS 10 AS $$
  SELECT s.id FROM sites s WHERE site_is_visible(s.id);
$$;

CREATE OR REPLACE FUNCTION visible_camera_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public ROWS 50 AS $$
  SELECT c.id FROM cameras c WHERE c.site_id IN (SELECT visible_site_ids());
$$;

COMMENT ON FUNCTION visible_site_ids() IS
  'Lokality viditelné přihlášenému. Pro RLS ve tvaru '
  '`site_id IN (SELECT visible_site_ids())`, které se vyhodnotí jednou '
  'na dotaz. Pravidlo je site_is_visible(), tahle funkce ho jen '
  'uplatní na seznam lokalit.';
COMMENT ON FUNCTION visible_camera_ids() IS
  'Kamery na lokalitách z visible_site_ids(). Pro tabulky, které '
  'lokalitu nemají a znají jen kameru (camera_recordings).';

-- Stejně jako ostatní funkce z politik (20260829180000): authenticated
-- je potřebuje, jinak spadne celý dotaz; anon na ně nesmí.
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['visible_site_ids()', 'visible_camera_ids()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ── Čtecí politiky podle lokality ──────────────────────────────────
--
-- Jen tabulky, které mají sloupec site_id a čtecí politiku
-- `site_is_visible(site_id)`. Smyčka místo devíti kopií: tvar je
-- u všech stejný a rozejít se nesmí.

DO $$
DECLARE
  t TEXT;
  tabulky TEXT[] := ARRAY[
    'detections',
    'vehicle_passages',
    'dispatches',
    'announced_arrivals',
    'cameras',
    'zones',
    'patrols',
    'known_plates'
  ];
BEGIN
  FOREACH t IN ARRAY tabulky LOOP
    -- Tabulka z nenasazené migrace se přeskočí, ne shodí celý běh.
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'read_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated '
      'USING (site_id IN (SELECT visible_site_ids()))',
      'read_' || t, t
    );
  END LOOP;
END $$;

-- ── Klipy: lokalitu nemají, znají kameru ───────────────────────────

DROP POLICY IF EXISTS "read_camera_recordings" ON camera_recordings;
CREATE POLICY "read_camera_recordings" ON camera_recordings
  FOR SELECT TO authenticated
  USING (camera_id IN (SELECT visible_camera_ids()));

-- ── Audit a běhy cronu: role se ověří jednou ───────────────────────
-- `(SELECT is_admin())` je InitPlan — vyhodnotí se jednou na dotaz.
-- Bez závorek se funkce volala na každý řádek auditu, a ten roste
-- s každou změnou v portálu.

DROP POLICY IF EXISTS "read_audit_log" ON audit_log;
CREATE POLICY "read_audit_log" ON audit_log
  FOR SELECT TO authenticated
  USING ((SELECT is_admin()));

DO $$
BEGIN
  IF to_regclass('public.cron_runs') IS NOT NULL THEN
    DROP POLICY IF EXISTS "read_cron_runs" ON cron_runs;
    CREATE POLICY "read_cron_runs" ON cron_runs
      FOR SELECT TO authenticated
      USING ((SELECT is_operator()));
  END IF;
END $$;
