-- ═══════════════════════════════════════════════════════════════════
-- Kontrola práv: žádná tabulka bez RLS, žádná práva pro anon.
--
-- ═══ Proč to není v migraci ════════════════════════════════════════
-- Migrace zkontroluje stav v okamžiku, kdy se pouští. Tabulka bez RLS
-- ale vznikne až někdy potom — a výchozí práva, která by ji zavřela,
-- se na Supabase nastavit nedají: na roli `supabase_admin` postgres
-- v SQL Editoru nedosáhne. Ochrana proto stojí na téhle kontrole.
--
-- ═══ Pouští se i PROTI PRODUKCI ════════════════════════════════════
-- Celý soubor je čistě čtecí: nezakládá, nemaže, nemění, nespouští
-- transakci. Nejsou v něm psql příkazy (`\set`, `\i`), takže se dá
-- vložit rovnou do SQL Editoru v Supabase.
--
-- Selhání je EXCEPTION, ne poznámka — SQL Editor ji ukáže červeně
-- a `psql -v ON_ERROR_STOP=1` skončí nenulově.
--
-- Lokálně ho pouští rls_deny_by_default.sql.
--
-- ═══ Co se toleruje ════════════════════════════════════════════════
-- Tabulky, které patří rozšíření (PostGIS `spatial_ref_sys` a spol.).
-- Nezaložil je portál, RLS na nich mít nemají a granty jsou jejich
-- věc; poznají se přes pg_depend s deptype 'e'.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_bez_rls   TEXT;
  v_anon      TEXT;
  v_tabulek   INT;
  v_politik   INT;
  v_potize    TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- ── Tabulky bez RLS ────────────────────────────────────────────
  -- Bez politik je taková tabulka otevřená každému, kdo má klíč —
  -- a veřejný anon klíč je v každé stránce portálu.
  SELECT count(*), string_agg(c.relname, ', ' ORDER BY c.relname)
       FILTER (WHERE NOT c.relrowsecurity)
    INTO v_tabulek, v_bez_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.deptype = 'e'
     );

  IF v_bez_rls IS NOT NULL THEN
    v_potize := v_potize || format('tabulky bez RLS: %s', v_bez_rls);
  END IF;

  -- ── Práva pro anon ─────────────────────────────────────────────
  -- has_table_privilege(), ne information_schema: chytí i práva
  -- udělená roli PUBLIC, ze kterých anon těží stejně.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    SELECT string_agg(format('%s (%s)', t.relname, t.prava), ', ' ORDER BY t.relname)
      INTO v_anon
      FROM (
        SELECT c.relname,
               (SELECT string_agg(p, ',')
                  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                    'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
                 WHERE has_table_privilege('anon', c.oid, p)) AS prava
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.objid = c.oid AND d.deptype = 'e'
           )
      ) t
     WHERE t.prava IS NOT NULL;

    IF v_anon IS NOT NULL THEN
      v_potize := v_potize || format('anon má práva na: %s', v_anon);
    END IF;
  ELSE
    RAISE NOTICE 'Role anon neexistuje — kontrola práv přeskočena.';
  END IF;

  -- ── Výsledek ───────────────────────────────────────────────────
  IF array_length(v_potize, 1) > 0 THEN
    RAISE EXCEPTION E'FAIL  kontrola práv neprošla:\n  - %',
      array_to_string(v_potize, E'\n  - ');
  END IF;

  SELECT count(*) INTO v_politik
    FROM pg_policies WHERE schemaname = 'public';

  RAISE NOTICE 'ok    % tabulek, všechny s RLS, % politik, anon bez práv',
    v_tabulek, v_politik;

  -- ── Tabulka s RLS a bez jediné politiky ────────────────────────
  -- Není to chyba (zavřeno pro všechny je bezpečný stav), ale bývá to
  -- omylem — třeba když někdo politiky teprve chystá.
  FOR v_bez_rls IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid AND d.deptype = 'e'
       )
     ORDER BY c.relname
  LOOP
    RAISE NOTICE 'pozn. tabulka „%“ má RLS a žádnou politiku — čte a píše do ní jen service_role.',
      v_bez_rls;
  END LOOP;

  RAISE NOTICE 'KONTROLA PRÁV PROŠLA';
END $$;
