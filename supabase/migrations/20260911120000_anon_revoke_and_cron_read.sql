-- ═══════════════════════════════════════════════════════════════════
-- Práva pro anon a čtení cron_runs.
--
-- ═══ 1) anon nemá co dělat v žádné tabulce ═════════════════════════
-- Supabase dává rolím `anon` a `authenticated` plná práva na všechny
-- tabulky ve schématu public — jednou plošně a znovu přes ALTER
-- DEFAULT PRIVILEGES pro každou nově založenou. Úzké GRANTy v našich
-- migracích (třeba `GRANT SELECT ON vehicle_passages TO authenticated`)
-- proto nic neomezují: širší právo už tam bylo.
--
-- Dnes to nevadí, protože RLS je zapnutá na všech tabulkách a `anon`
-- nemá jedinou politiku. Vadí to ve chvíli, kdy vznikne tabulka, u níž
-- se na `ENABLE ROW LEVEL SECURITY` zapomene: ta je okamžitě čitelná
-- I ZAPISOVATELNÁ komukoli, kdo zná veřejný anon klíč — a ten je
-- v každé stránce portálu.
--
-- Tahle migrace bere `anon` práva na tabulky (má je mít jen přes
-- politiky, a žádné pro něj nejsou) a mění výchozí práva pro tabulky
-- příští. Přihlášeným (`authenticated`) se nesahá na nic: tam RLS
-- pracuje a zúžení práv by rozbilo běžný provoz.
--
-- POZOR: `anon` roli potřebuje přihlašování (Supabase Auth běží mimo
-- schema public) a stránka řidiče, která jede pod service_role. Nic
-- z toho tabulky ve public přes anon nečte.
--
-- ═══ 2) cron_runs nečte klient ═════════════════════════════════════
-- Politika byla USING (TRUE), tedy pro každého přihlášeného. Klient
-- z ní vyčte provozní čísla přes CELÝ systém: kolik je lokalit
-- dohromady, kolik hlídek se plánuje, kolik nálezů se potvrdilo.
-- Jsou to čísla o cizích areálech, i když neadresná.
--
-- Přehled na jejich základě hlásí zaseklý cron; klientovi to nic
-- neříká, protože s tím stejně nic neudělá.
--
-- Idempotentní: bezpečné spustit víckrát.
-- ═══════════════════════════════════════════════════════════════════

SET search_path = public, extensions;

-- ── 1) anon ──────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Výchozí práva pro tabulky, které teprve vzniknou. `FOR ROLE postgres`
-- i bez něj: migrace se pouštějí jako postgres přes SQL Editor, ale
-- tabulku může založit i supabase_admin.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon', r);
    END IF;
  END LOOP;
END $$;

-- ── 2) cron_runs ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "read_cron_runs" ON cron_runs;
CREATE POLICY "read_cron_runs" ON cron_runs
  FOR SELECT TO authenticated
  USING (is_operator());

COMMENT ON TABLE cron_runs IS
  'Kdy naposledy proběhl který cron a s jakým výsledkem. Přehled z toho '
  'hlásí varování, když je poslední běh starší než trojnásobek '
  'intervalu daného endpointu. Čte operátor a admin — klientovi čísla '
  'přes celý systém nic neřeknou a jsou to čísla i o cizích areálech.';

-- ── 3) Pojistka: tabulka bez RLS ─────────────────────────────────
--
-- Revoke výš je záchranná síť, ne náhrada RLS. Když by někdo založil
-- tabulku a zapomněl na politiky, tenhle výpis to řekne nahlas při
-- příštím běhu migrací.

DO $$
DECLARE v_bez TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bez
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

  IF v_bez IS NOT NULL THEN
    RAISE WARNING 'Tabulky bez RLS: %. Bez politik jsou otevřené všem, kdo mají klíč.', v_bez;
  ELSE
    RAISE NOTICE 'Všechny tabulky mají zapnutou RLS.';
  END IF;
END $$;
