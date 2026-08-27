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
-- Tahle migrace bere `anon` práva na STÁVAJÍCÍ tabulky (má je mít jen
-- přes politiky, a žádné pro něj nejsou). Přihlášeným
-- (`authenticated`) se nesahá na nic: tam RLS pracuje a zúžení práv by
-- rozbilo běžný provoz.
--
-- Výchozí práva pro tabulky BUDOUCÍ se zkoušejí taky, ale na roli
-- supabase_admin postgres v SQL Editoru nedosáhne. Nedostatek práv
-- proto migraci neshodí, jen vypíše poznámku — a tabulky, které
-- teprve vzniknou, hlídá test supabase/tests/rls_audit.sql.
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

-- ── 1) anon: stávající tabulky ───────────────────────────────────
--
-- Tohle je ta podstatná část a projde vždycky: vlastníkem tabulek je
-- postgres, tedy role, pod kterou se migrace pouští.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ── 1b) anon: tabulky, které teprve vzniknou ─────────────────────
--
-- ═══ Nemusí projít, a je to tak v pořádku ══════════════════════════
-- Výchozí práva se nastavují ZVLÁŠŤ pro každou roli, která objekt
-- zakládá. Na `FOR ROLE supabase_admin` ale postgres v SQL Editoru
-- nedosáhne — Supabase si tu roli drží pro sebe a odpoví
-- „permission denied to change default privileges“. Ověřeno naostro.
--
-- Kdyby ten příkaz stál v migraci nahý, shodil by ji celou — a s ní
-- i REVOKE výš, který projde a je důležitější. Každý pokus je proto
-- ve vlastním bloku a nedostatek práv jen vypíše poznámku.
--
-- Co se nepodaří nastavit, hlídá TEST: supabase/tests/rls_audit.sql
-- spadne, jakmile se objeví tabulka bez RLS nebo s právy pro anon.
-- Pouští se lokálně v rls_deny_by_default.sql a dá se pustit i proti
-- produkci — je čistě čtecí a bez psql příkazů, takže se vloží přímo
-- do SQL Editoru. Ochrana se tím z databáze přesouvá do kontroly,
-- kterou někdo pustí; horší než výchozí práva, pořád lepší než nic.
-- ═════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_role   TEXT;
  v_objekt TEXT;
  v_prikaz TEXT;
BEGIN
  -- NULL = bez FOR ROLE, tedy pro roli, která migraci pouští.
  FOREACH v_role IN ARRAY ARRAY[NULL, 'postgres', 'supabase_admin']::TEXT[] LOOP
    CONTINUE WHEN v_role IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);

    FOREACH v_objekt IN ARRAY ARRAY['TABLES', 'SEQUENCES'] LOOP
      v_prikaz := format(
        'ALTER DEFAULT PRIVILEGES%s IN SCHEMA public REVOKE ALL ON %s FROM anon',
        CASE WHEN v_role IS NULL THEN '' ELSE format(' FOR ROLE %I', v_role) END,
        v_objekt);

      BEGIN
        EXECUTE v_prikaz;
        RAISE NOTICE 'Výchozí práva upravena: %', v_prikaz;
      EXCEPTION
        WHEN insufficient_privilege THEN
          -- Přesně tenhle případ: role patří Supabase a postgres na ni
          -- nedosáhne. Hlídá to test, ne databáze.
          RAISE NOTICE 'Na výchozí práva role % nedosáhneme — hlídá to rls_audit.sql.',
            coalesce(v_role, 'current_user');
      END;
    END LOOP;
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

-- ── 3) Pojistka je v testu, ne tady ──────────────────────────────
--
-- Migrace zkontroluje stav v okamžiku, kdy se pouští; tabulka bez RLS
-- ale vznikne až někdy potom. Kontrola proto patří do něčeho, co se
-- pouští opakovaně — supabase/tests/rls_audit.sql.

DO $$
BEGIN
  RAISE NOTICE 'Hotovo. Stav práv ověřte kdykoli souborem supabase/tests/rls_audit.sql.';
END $$;
