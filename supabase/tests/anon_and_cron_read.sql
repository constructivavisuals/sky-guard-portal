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

  -- ── Nová tabulka je taky bez anon ──────────────────────────────
  -- Tohle je ta podstatná část: výchozí práva se vztahují na tabulky,
  -- které teprve vzniknou, a právě u nich se na politiky zapomíná.
  CREATE TABLE _rls_pokus (id INT);

  SELECT count(*) INTO v_pocet
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'anon' AND table_name = '_rls_pokus';

  IF v_pocet > 0 THEN
    RAISE EXCEPTION 'FAIL nově založená tabulka dala anon práva';
  END IF;
  RAISE NOTICE 'ok    nově založená tabulka anon práva nedává';

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

  -- ── Každá tabulka má RLS ───────────────────────────────────────
  SELECT count(*), string_agg(c.relname, ', ')
    INTO v_pocet, v_kdo
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

  IF v_pocet > 0 THEN
    RAISE EXCEPTION 'FAIL tabulky bez RLS: %', v_kdo;
  END IF;
  RAISE NOTICE 'ok    všechny tabulky mají zapnutou RLS';

  RAISE NOTICE 'VŠECHNY TESTY PROŠLY';
END $$;
