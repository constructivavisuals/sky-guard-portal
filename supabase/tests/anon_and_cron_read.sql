-- Práva role anon a čtení cron_runs.
--
-- anon je role, pod kterou jede každý požadavek s veřejným klíčem —
-- ten je v každé stránce portálu. Nemá mít na tabulkách ve public
-- vůbec žádné právo: RLS je hráz, tohle je zeď za ní.

\set ON_ERROR_STOP on
SET search_path = public, extensions;

DO $$
DECLARE
  v_pocet INT;
  v_kdo   TEXT;
BEGIN
  -- ── anon nemá práva na žádnou tabulku ──────────────────────────
  SELECT count(*), string_agg(DISTINCT table_name, ', ')
    INTO v_pocet, v_kdo
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'anon';

  IF v_pocet > 0 THEN
    RAISE EXCEPTION 'FAIL anon má práva na tabulky: %', v_kdo;
  END IF;
  RAISE NOTICE 'ok    anon nemá práva na žádnou tabulku';

  -- ── Nová tabulka ───────────────────────────────────────────────
  -- Výchozí práva se na Supabase nastavit nedají u role
  -- supabase_admin (postgres na ni nedosáhne), takže se tady jen
  -- vypíše, jak to na TÉHLE databázi dopadlo. Skutečnou pojistkou je
  -- rls_audit.sql, který se pouští opakovaně.
  CREATE TABLE _rls_pokus (id INT);

  SELECT count(*) INTO v_pocet
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'anon' AND table_name = '_rls_pokus';

  IF v_pocet > 0 THEN
    RAISE NOTICE 'pozn. nově založená tabulka anon práva DÁVÁ — hlídá to rls_audit.sql';
  ELSE
    RAISE NOTICE 'ok    nově založená tabulka anon práva nedává';
  END IF;

  DROP TABLE _rls_pokus;

  -- ── authenticated práva ZŮSTÁVAJÍ ──────────────────────────────
  -- Přihlášeným se nesahá na nic: tam pracuje RLS a zúžení práv by
  -- rozbilo běžný provoz.
  SELECT count(*) INTO v_pocet
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'authenticated' AND table_name = 'sites';

  IF v_pocet = 0 THEN
    RAISE EXCEPTION 'FAIL revoke sebral práva i přihlášeným';
  END IF;
  RAISE NOTICE 'ok    přihlášeným práva zůstala';

  -- ── cron_runs čte jen operátor ─────────────────────────────────
  SELECT count(*) INTO v_pocet
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'cron_runs' AND qual = 'is_operator()';

  IF v_pocet <> 1 THEN
    RAISE EXCEPTION 'FAIL cron_runs nemá politiku na is_operator()';
  END IF;
  RAISE NOTICE 'ok    cron_runs čte jen operátor a admin';

  -- Že žádná tabulka nezůstala bez RLS, hlídá rls_audit.sql — ten se
  -- dá pustit i proti produkci a nezávisí na tomhle souboru.

  RAISE NOTICE 'VŠECHNY TESTY PROŠLY';
END $$;
