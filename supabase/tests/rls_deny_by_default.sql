-- ═══════════════════════════════════════════════════════════════════
-- Regrese na past 4A z bezpečnostního auditu.
--
-- site_is_visible() definuje základní migrace a rozšiřuje ji až
-- 20260824180000 o granty. Migrace se pouštějí ručně, takže se ta
-- základní může omylem pustit znovu — a tím přepsat funkci zpátky.
--
-- Tenhle soubor se pouští PO takovém znovuspuštění a ověřuje, že
-- nejhorší možný následek je zavřeno, ne otevřeno: klient nevidí nic,
-- ani na lokalitu, na kterou grant má. Admin vidí dál.
--
-- Běží v transakci ukončené ROLLBACKem.
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
BEGIN;
SET search_path = public, extensions;

CREATE FUNCTION public.test_expect(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok    % = %', label, actual;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect(TEXT, BIGINT, BIGINT) TO authenticated;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000b2');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'admin@sky-guard.cz', 'admin'),
  ('00000000-0000-0000-0000-0000000000b2', 'klient@kralupy.cz', 'viewer');
INSERT INTO sites (id, name, timezone) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Areál Kralupy', 'Europe/Prague');
INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c1');

-- ── Klient s grantem ─────────────────────────────────────────────
-- Grant existuje, ale funkce po znovuspuštění o grantech neví.
-- Správná odpověď je nula, ne „vidí všechno“.

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2"}';

SELECT test_expect('klient s grantem po znovuspuštění nevidí nic', (
  SELECT count(*) FROM sites), 0);

RESET ROLE;

-- ── Admin ────────────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1"}';

SELECT test_expect('admin vidí dál', (SELECT count(*) FROM sites), 1);

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
