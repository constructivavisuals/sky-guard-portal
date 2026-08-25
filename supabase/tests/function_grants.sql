-- ═══════════════════════════════════════════════════════════════════
-- Test práv na pomocné funkce (audit 2A).
--
-- Ověřuje dvě věci naráz:
--   * anon se k funkcím vůbec nedostane — anon klíč je veřejný,
--   * přihlášený se přes site_is_armed() nedozví nic o cizí lokalitě,
--     zatímco ingest a cron (bez auth.uid()) odpověď dostanou.
--
-- Běží v transakci ukončené ROLLBACKem.
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
BEGIN;
SET search_path = public, extensions;

CREATE FUNCTION public.test_expect_bool(label TEXT, actual BOOLEAN, expected BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % — čekáno %, dostal %', label,
      COALESCE(expected::TEXT, 'NULL'), COALESCE(actual::TEXT, 'NULL');
  END IF;
  RAISE NOTICE 'ok    % = %', label, COALESCE(actual::TEXT, 'NULL');
END $$;

CREATE FUNCTION public.test_expect_denied_fn(label TEXT, stmt TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'FAIL  % — prošlo, ačkoli mělo být odmítnuto', label;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ok    % — odmítnuto právy', label;
END $$;

GRANT EXECUTE ON FUNCTION public.test_expect_bool(TEXT, BOOLEAN, BOOLEAN) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.test_expect_denied_fn(TEXT, TEXT) TO authenticated, anon;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000d2');
INSERT INTO profiles (id, email, role) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'klient-a@example.com', 'viewer'),
  ('00000000-0000-0000-0000-0000000000d2', 'klient-b@example.com', 'viewer');

-- Obě lokality hlídají nepřetržitě, takže rozvrh vrací TRUE a jediné,
-- co může odpověď změnit, je kontrola viditelnosti.
INSERT INTO sites (id, name, timezone, armed_from, armed_to, armed_days) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'Areál A', 'Europe/Prague',
   '00:00', '23:59', ARRAY[1,2,3,4,5,6,7]),
  ('00000000-0000-0000-0000-0000000000e2', 'Areál B', 'Europe/Prague',
   '00:00', '23:59', ARRAY[1,2,3,4,5,6,7]);

INSERT INTO site_grants (profile_id, site_id) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1');

-- ── Service role: odpověď dostane, granty ho nezajímají ──────────
-- Ingest podle ní rozhoduje o zásahu.

SELECT test_expect_bool('bez přihlášení (service role) vrací rozvrh',
  site_is_armed('00000000-0000-0000-0000-0000000000e1',
                '2026-08-25 12:00:00+02'::TIMESTAMPTZ), TRUE);

-- ── anon: nesmí se dostat vůbec nikam ────────────────────────────

SET LOCAL ROLE anon;

SELECT test_expect_denied_fn('anon nesmí volat site_is_armed', $sql$
  SELECT site_is_armed('00000000-0000-0000-0000-0000000000e1')
$sql$);

SELECT test_expect_denied_fn('anon nesmí volat is_admin', $sql$
  SELECT is_admin()
$sql$);

SELECT test_expect_denied_fn('anon nesmí volat site_is_visible', $sql$
  SELECT site_is_visible('00000000-0000-0000-0000-0000000000e1')
$sql$);

SELECT test_expect_denied_fn('anon nesmí volat camera_site_id', $sql$
  SELECT camera_site_id('00000000-0000-0000-0000-0000000000e1')
$sql$);

RESET ROLE;

-- ── Klient A: svou lokalitu ano, cizí ne ─────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';

SELECT test_expect_bool('klient vidí stav své lokality',
  site_is_armed('00000000-0000-0000-0000-0000000000e1',
                '2026-08-25 12:00:00+02'::TIMESTAMPTZ), TRUE);

-- NULL, ne FALSE: „nesmíš vědět“ není totéž co „není střeženo“.
SELECT test_expect_bool('o cizí lokalitě se nedozví nic',
  site_is_armed('00000000-0000-0000-0000-0000000000e2',
                '2026-08-25 12:00:00+02'::TIMESTAMPTZ), NULL);

-- Obcházení přes vnitřní funkci nesmí projít.
SELECT test_expect_denied_fn('klient nesmí volat vnitřní rozvrh', $sql$
  SELECT site_armed_schedule('00000000-0000-0000-0000-0000000000e2',
                             '2026-08-25 12:00:00+02'::TIMESTAMPTZ)
$sql$);

RESET ROLE;

-- ── Klient B: nemá grant na nic ──────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d2"}';

SELECT test_expect_bool('klient bez grantu se nedozví nic o A',
  site_is_armed('00000000-0000-0000-0000-0000000000e1',
                '2026-08-25 12:00:00+02'::TIMESTAMPTZ), NULL);

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'VŠECHNY TESTY PROŠLY'; END $$;
ROLLBACK;
