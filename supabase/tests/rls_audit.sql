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
-- ═══ Servisní role relaye ══════════════════════════════════════════
-- Druhá půlka kontroly hlídá role, pod kterými běží relay na cizím
-- serveru (cam_ingest, cam_retention). Jejich smysl je, že umí přesně
-- to, co potřebují, a nic víc — což je tvrzení, které se musí ověřovat,
-- ne opakovat. Whitelist níž je proto úplný: cokoli navíc je chyba.
--
-- Kdyby se role rozšířila legitimně, patří změna do seznamu SPOLU
-- s migrací. Test, který se dopisuje až po nálezu, nehlídá nic.
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

  RAISE NOTICE 'ok    role anon a RLS v pořádku';
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Práva servisních rolí relaye — úplný whitelist.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Očekávaný stav ve tvaru `role:tabulka.sloupec:PRÁVO`, seřazeně.
  -- Migrace 20260915180000_camera_service_roles.sql.
  v_ocekavano TEXT[] := ARRAY[
    'cam_ingest:camera_recordings.camera_id:INSERT',
    'cam_ingest:camera_recordings.ended_at:INSERT',
    'cam_ingest:camera_recordings.event_type:INSERT',
    'cam_ingest:camera_recordings.id:SELECT',
    'cam_ingest:camera_recordings.r2_key:INSERT',
    'cam_ingest:camera_recordings.sd_file_path:INSERT',
    'cam_ingest:camera_recordings.sd_file_path:SELECT',
    'cam_ingest:camera_recordings.size_bytes:INSERT',
    'cam_ingest:camera_recordings.started_at:INSERT',
    'cam_ingest:cameras.ftp_username:SELECT',
    'cam_ingest:cameras.id:SELECT',
    'cam_ingest:cameras.ingest_mode:SELECT',
    'cam_ingest:cameras.last_seen_at:UPDATE',
    'cam_ingest:cameras.serial_number:SELECT',
    'cam_retention:camera_recordings.camera_id:SELECT',
    'cam_retention:camera_recordings.id:SELECT',
    'cam_retention:camera_recordings.r2_key:SELECT',
    'cam_retention:camera_recordings.size_bytes:SELECT',
    'cam_retention:camera_recordings.started_at:SELECT',
    'cam_retention:camera_recordings.video_expired_at:SELECT',
    'cam_retention:camera_recordings.video_expired_at:UPDATE',
    'cam_retention:cameras.id:SELECT',
    'cam_retention:cameras.site_id:SELECT',
    'cam_retention:sites.clip_retention_days:SELECT',
    'cam_retention:sites.id:SELECT'
  ];
  v_skutecnost TEXT[];
  v_navic      TEXT[];
  v_chybi      TEXT[];
  v_tabulkove  TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cam_ingest') THEN
    RAISE NOTICE 'pozn. servisní role relaye neexistují — migrace 20260915180000 zatím neběžela.';
    RETURN;
  END IF;

  -- ── Žádné právo na CELOU tabulku ───────────────────────────────
  -- Sloupcový grant je to, co drží roli u země. Právo na tabulku by
  -- ho tiše přebilo a whitelist níž by o tom nevěděl.
  SELECT string_agg(format('%s → %s (%s)', grantee, table_name, privilege_type), ', ')
    INTO v_tabulkove
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee IN ('cam_ingest', 'cam_retention');

  IF v_tabulkove IS NOT NULL THEN
    RAISE EXCEPTION E'FAIL  servisní role má právo na celou tabulku:\n  - %', v_tabulkove;
  END IF;

  -- ── Sloupcové granty ───────────────────────────────────────────
  SELECT coalesce(array_agg(format('%s:%s.%s:%s', g.grantee, g.table_name,
                                   g.column_name, g.privilege_type)
                            ORDER BY g.grantee, g.table_name, g.column_name,
                                     g.privilege_type), ARRAY[]::TEXT[])
    INTO v_skutecnost
    FROM information_schema.column_privileges g
   WHERE g.table_schema = 'public'
     AND g.grantee IN ('cam_ingest', 'cam_retention');

  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::TEXT[]) INTO v_navic
    FROM unnest(v_skutecnost) AS x
   WHERE x <> ALL (v_ocekavano);

  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::TEXT[]) INTO v_chybi
    FROM unnest(v_ocekavano) AS x
   WHERE x <> ALL (v_skutecnost);

  IF array_length(v_navic, 1) > 0 THEN
    RAISE EXCEPTION E'FAIL  servisní role má práva navíc:\n  - %',
      array_to_string(v_navic, E'\n  - ');
  END IF;

  -- Chybějící právo není bezpečnostní problém, ale znamená, že se
  -- migrace a test rozešly — a pak whitelist hlídá něco jiného, než
  -- co v databázi opravdu je.
  IF array_length(v_chybi, 1) > 0 THEN
    RAISE EXCEPTION E'FAIL  seznam nesedí s databází, chybí:\n  - %',
      array_to_string(v_chybi, E'\n  - ');
  END IF;

  RAISE NOTICE 'ok    servisní role mají přesně % sloupcových práv', array_length(v_skutecnost, 1);
  RAISE NOTICE 'KONTROLA PRÁV PROŠLA';
END $$;
